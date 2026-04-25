import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import Groq from 'groq-sdk'
import { DEFAULT_SETTINGS } from '../lib/settings.ts'
import type { MeetingContext, Suggestion, TranscriptChunk } from '../lib/store.ts'
import { generateSuggestionBatch } from '../lib/suggestions.ts'
import { streamDetailedAnswer } from '../lib/chat.ts'

type Scenario = {
  id: string
  name: string
  meetingContext: MeetingContext
  transcript: TranscriptChunk[]
  mustCoverAny?: string[]
  antiPatterns?: string[]
  detailScenario?: string
}

type EvalResult = {
  scenarioId: string
  scenarioName: string
  suggestionScore?: number
  detailScore?: number
  impressive: boolean
  shouldShip: boolean
  strengths: string[]
  weaknesses: string[]
  verdict: string
}

type JsonShape = 'object' | 'array'
const MAX_AUTOMATIC_RETRY_WAIT_MS = 90_000

function parseArgs(argv: string[]) {
  const args = new Set(argv)
  const getValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }

  return {
    dryRun: args.has('--dry-run'),
    mode: getValue('--mode') ?? 'all',
    fixture: getValue('--fixture'),
  }
}

async function loadScenarios(): Promise<Scenario[]> {
  const filePath = path.join(process.cwd(), 'eval', 'scenarios.json')
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as { scenarios: Scenario[] }
  return parsed.scenarios
}

function extractJsonCandidate(raw: string, shape: JsonShape): string {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const open = shape === 'array' ? '[' : '{'
  const close = shape === 'array' ? ']' : '}'
  const start = cleaned.indexOf(open)
  const end = cleaned.lastIndexOf(close)

  if (start >= 0 && end >= 0) {
    return cleaned.slice(start, end + 1)
  }

  return cleaned
}

function parseJsonCandidate<T>(raw: string, shape: JsonShape): T {
  return JSON.parse(extractJsonCandidate(raw, shape)) as T
}

async function repairJsonWithModel(
  groq: Groq,
  raw: string,
  shape: JsonShape,
  maxTokens: number
): Promise<string> {
  const repair = await callGroqWithRetry(groq, {
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'system',
        content: `You repair malformed JSON. Return ONLY valid ${shape === 'array' ? 'JSON array' : 'JSON object'} syntax. Do not add commentary.`
      },
      {
        role: 'user',
        content: `Repair this malformed payload into valid ${shape === 'array' ? 'JSON array' : 'JSON object'}:\n\n${raw}`
      }
    ],
    temperature: 0,
    max_tokens: maxTokens,
  })

  return repair.choices[0]?.message?.content ?? (shape === 'array' ? '[]' : '{}')
}

function extractRetryDelayMs(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  const minuteSecondMatch = message.match(/Please try again in\s+([0-9]+)m([0-9.]+)s/i)
  if (minuteSecondMatch) {
    return (Number(minuteSecondMatch[1]) * 60_000) + Math.ceil(Number(minuteSecondMatch[2]) * 1000) + 400
  }

  const secondsMatch = message.match(/Please try again in\s+([0-9.]+)s/i)
  if (secondsMatch) {
    return Math.ceil(Number(secondsMatch[1]) * 1000) + 400
  }

  const msMatch = message.match(/retry after\s+([0-9]+)ms/i)
  if (msMatch) {
    return Number(msMatch[1]) + 400
  }

  return 2500
}

function isRetryableGroqError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('rate_limit_exceeded') || message.includes('Rate limit reached') || message.includes('429')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function callGroqWithRetry(
  groq: Groq,
  request: Parameters<typeof groq.chat.completions.create>[0],
  attempts = 5
) {
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await groq.chat.completions.create(request)
    } catch (error) {
      lastError = error
      if (!isRetryableGroqError(error) || attempt === attempts - 1) throw error
      const delayMs = extractRetryDelayMs(error) + attempt * 500
      if (delayMs > MAX_AUTOMATIC_RETRY_WAIT_MS) {
        const seconds = Math.round(delayMs / 1000)
        throw new Error(`Groq rate limit requires waiting about ${seconds}s. Aborting early instead of hanging. Retry later or use a different key. Original error: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(delayMs)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function createJsonCompletion(
  groq: Groq,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  shape: JsonShape,
  maxTokens: number,
  temperature: number,
  forceJsonObject = false
): Promise<string> {
  const makeRequest = async (
    requestMessages: Array<{ role: 'system' | 'user'; content: string }>,
    requestTemperature: number,
    useResponseFormat: boolean
  ) => {
    try {
      return await callGroqWithRetry(groq, {
        model: 'openai/gpt-oss-120b',
        messages: requestMessages,
        temperature: requestTemperature,
        max_tokens: maxTokens,
        ...(useResponseFormat ? { response_format: { type: 'json_object' as const } } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const shouldFallback = useResponseFormat && (
        message.includes('json_validate_failed') ||
        message.includes('Failed to validate JSON') ||
        message.includes('Failed to generate JSON')
      )
      if (!shouldFallback) throw error

      return callGroqWithRetry(groq, {
        model: 'openai/gpt-oss-120b',
        messages: [
          ...requestMessages,
          {
            role: 'user',
            content: `The API rejected your last output for invalid JSON. Return ONLY valid ${shape === 'array' ? 'JSON array' : 'JSON object'} syntax now. No markdown, no commentary.`
          }
        ],
        temperature: 0,
        max_tokens: maxTokens,
      })
    }
  }

  try {
    const response = await makeRequest(messages, temperature, forceJsonObject)
    const raw = response.choices[0]?.message?.content ?? (shape === 'array' ? '[]' : '{}')
    parseJsonCandidate(raw, shape)
    return raw
  } catch {
    const retryMessages = [
      ...messages,
      {
        role: 'user' as const,
        content: `Your last response was not valid JSON. Return ONLY valid JSON ${shape === 'array' ? 'array' : 'object'} syntax. No markdown, no explanation, escape internal quotes correctly.`
      }
    ]

    const retry = await makeRequest(retryMessages, 0.1, forceJsonObject)

    try {
      const retryRaw = retry.choices[0]?.message?.content ?? (shape === 'array' ? '[]' : '{}')
      parseJsonCandidate(retryRaw, shape)
      return retryRaw
    } catch {
      const finalRetry = await makeRequest(
        [
          ...retryMessages,
          {
            role: 'user',
            content: `Final retry. Return ONLY syntactically valid ${shape === 'array' ? 'JSON array' : 'JSON object'}. Use double quotes for all strings. Do not include line breaks inside strings unless escaped.`
          }
        ],
        0,
        forceJsonObject
      )

      const finalRaw = finalRetry.choices[0]?.message?.content ?? (shape === 'array' ? '[]' : '{}')
      try {
        parseJsonCandidate(finalRaw, shape)
        return finalRaw
      } catch {
        const repaired = await repairJsonWithModel(groq, finalRaw, shape, maxTokens)
        parseJsonCandidate(repaired, shape)
        return repaired
      }
    }
  }
}

function toRuntimeTranscript(chunks: Scenario['transcript']): TranscriptChunk[] {
  return chunks.map((chunk, index) => ({
    id: `eval-${index + 1}`,
    timestamp: chunk.timestamp,
    text: chunk.text,
  }))
}

async function collectStream(stream: AsyncGenerator<string>): Promise<string> {
  let full = ''
  for await (const chunk of stream) full += chunk
  return full.trim()
}

async function generateSuggestions(apiKey: string, scenario: Scenario): Promise<Suggestion[]> {
  const transcript = toRuntimeTranscript(scenario.transcript)
  const batch = await generateSuggestionBatch(
    transcript,
    apiKey,
    DEFAULT_SETTINGS,
    scenario.meetingContext,
    [],
    undefined,
    {}
  )

  return batch.suggestions
}

async function generateDetailedAnswer(apiKey: string, scenario: Scenario, suggestion: Suggestion): Promise<string> {
  const transcript = toRuntimeTranscript(scenario.transcript)
  return collectStream(streamDetailedAnswer(
    suggestion.title,
    suggestion.type,
    suggestion.detail,
    suggestion.say,
    suggestion.whyNow,
    suggestion.listenFor,
    transcript,
    apiKey,
    DEFAULT_SETTINGS,
    scenario.meetingContext
  ))
}

async function judgeJson<T>(groq: Groq, prompt: string): Promise<T> {
  const raw = await createJsonCompletion(
    groq,
    [{ role: 'user', content: prompt }],
    'object',
    1800,
    0.1,
    true
  )

  return parseJsonCandidate<T>(raw, 'object')
}

function buildSuggestionJudgePrompt(scenario: Scenario, suggestions: Suggestion[]): string {
  return `You are an expert evaluator for a live meeting copilot. Grade whether these suggestions would genuinely impress a product team like TwinMind.

## Scenario
Meeting type: ${scenario.meetingContext.meetingType}
User role: ${scenario.meetingContext.userRole}
Goal: ${scenario.meetingContext.goal}

Transcript:
${scenario.transcript.map((line) => `[${line.timestamp}] ${line.text}`).join('\n')}

Must-cover concepts if relevant:
${(scenario.mustCoverAny ?? []).map((item) => `- ${item}`).join('\n') || '- none'}

Anti-patterns:
${(scenario.antiPatterns ?? []).map((item) => `- ${item}`).join('\n') || '- none'}

Suggestions to evaluate:
${suggestions.map((s, index) => [
  `${index + 1}. [${s.type}] ${s.title}`,
  `   Detail: ${s.detail}`,
  s.say ? `   Say: ${s.say}` : '',
  s.whyNow ? `   Why now: ${s.whyNow}` : '',
  s.listenFor ? `   Listen for: ${s.listenFor}` : '',
].filter(Boolean).join('\n')).join('\n')}

## Rubric
Score each dimension 1-5:
- grounding
- timing
- actionability
- diversity
- relevance

Then give suggestionScore as ONE overall score from 1-5 for the whole batch, not a sum.

Then decide:
- impressive = true only if the batch would feel notably helpful in a real meeting
- shouldShip = true only if this output is good enough to keep as-is

Return ONLY valid JSON:
{
  "suggestionScore": 0,
  "impressive": false,
  "shouldShip": false,
  "strengths": [""],
  "weaknesses": [""],
  "verdict": ""
}`
}

function buildDetailJudgePrompt(scenario: Scenario, suggestion: Suggestion, answer: string): string {
  return `You are evaluating a click-to-expand detailed answer for a live meeting copilot.

Scenario:
Meeting type: ${scenario.meetingContext.meetingType}
User role: ${scenario.meetingContext.userRole}
Goal: ${scenario.meetingContext.goal}
User need: ${scenario.detailScenario ?? 'The user needs a strong real-time answer.'}

Transcript:
${scenario.transcript.map((line) => `[${line.timestamp}] ${line.text}`).join('\n')}

Clicked suggestion:
[${suggestion.type}] ${suggestion.title}
${suggestion.detail}

Detailed answer:
${answer}

Score 1-5 on:
- grounding
- directiveness
- usefulness in the next 30 seconds
- trustworthiness

Then give detailScore as ONE overall score from 1-5 for the answer, not a sum.

Return ONLY valid JSON:
{
  "detailScore": 0,
  "strengths": [""],
  "weaknesses": [""],
  "verdict": ""
}`
}

function mergeNotes(...lists: Array<string[] | undefined>): string[] {
  return lists.flatMap((list) => list ?? []).filter(Boolean).slice(0, 6)
}

function normalizeScore(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  const rounded = Math.round(value * 10) / 10
  return Math.min(5, Math.max(1, rounded))
}

async function evaluateScenario(
  groq: Groq,
  apiKey: string,
  scenario: Scenario,
  mode: string
): Promise<EvalResult> {
  const suggestions = await generateSuggestions(apiKey, scenario)

  const suggestionJudgement = mode === 'detail'
    ? null
    : await judgeJson<{
      suggestionScore: number
      impressive: boolean
      shouldShip: boolean
      strengths: string[]
      weaknesses: string[]
      verdict: string
    }>(groq, buildSuggestionJudgePrompt(scenario, suggestions))

  let detailJudgement: {
    detailScore: number
    strengths: string[]
    weaknesses: string[]
    verdict: string
  } | null = null

  if ((mode === 'all' || mode === 'detail') && suggestions[0]) {
    const answer = await generateDetailedAnswer(apiKey, scenario, suggestions[0])
    detailJudgement = await judgeJson(groq, buildDetailJudgePrompt(scenario, suggestions[0], answer))
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    suggestionScore: normalizeScore(suggestionJudgement?.suggestionScore),
    detailScore: normalizeScore(detailJudgement?.detailScore),
    impressive: suggestionJudgement?.impressive ?? ((normalizeScore(detailJudgement?.detailScore) ?? 0) >= 4),
    shouldShip: suggestionJudgement?.shouldShip ?? ((normalizeScore(detailJudgement?.detailScore) ?? 0) >= 4),
    strengths: mergeNotes(suggestionJudgement?.strengths, detailJudgement?.strengths),
    weaknesses: mergeNotes(suggestionJudgement?.weaknesses, detailJudgement?.weaknesses),
    verdict: [suggestionJudgement?.verdict, detailJudgement?.verdict].filter(Boolean).join(' | '),
  }
}

function printDryRun(scenarios: Scenario[]) {
  console.log(`Loaded ${scenarios.length} prompt-eval scenarios:\n`)
  for (const scenario of scenarios) {
    console.log(`- ${scenario.id}: ${scenario.name}`)
    console.log(`  Meeting: ${scenario.meetingContext.meetingType} · Role: ${scenario.meetingContext.userRole}`)
    console.log(`  Goal: ${scenario.meetingContext.goal}`)
    console.log(`  Transcript lines: ${scenario.transcript.length}`)
    if (scenario.mustCoverAny?.length) console.log(`  Must cover: ${scenario.mustCoverAny.join(', ')}`)
    console.log('')
  }
}

function printResults(results: EvalResult[]) {
  const suggestionScores = results.map((result) => result.suggestionScore).filter((value): value is number => typeof value === 'number')
  const detailScores = results.map((result) => result.detailScore).filter((value): value is number => typeof value === 'number')

  console.log('\nPrompt evaluation results\n')
  for (const result of results) {
    console.log(`- ${result.scenarioId}: ${result.scenarioName}`)
    if (typeof result.suggestionScore === 'number') console.log(`  Suggestion score: ${result.suggestionScore}/5`)
    if (typeof result.detailScore === 'number') console.log(`  Detail score: ${result.detailScore}/5`)
    console.log(`  Impressive: ${result.impressive ? 'yes' : 'no'} · Ship: ${result.shouldShip ? 'yes' : 'no'}`)
    console.log(`  Verdict: ${result.verdict}`)
    if (result.strengths.length) console.log(`  Strengths: ${result.strengths.join(' | ')}`)
    if (result.weaknesses.length) console.log(`  Weaknesses: ${result.weaknesses.join(' | ')}`)
    console.log('')
  }

  if (suggestionScores.length) {
    const average = suggestionScores.reduce((sum, value) => sum + value, 0) / suggestionScores.length
    console.log(`Average suggestion score: ${average.toFixed(2)}/5`)
  }

  if (detailScores.length) {
    const average = detailScores.reduce((sum, value) => sum + value, 0) / detailScores.length
    console.log(`Average detail score: ${average.toFixed(2)}/5`)
  }
}

async function persistResults(results: EvalResult[], mode: string, fixture?: string) {
  const directory = path.join(process.cwd(), 'eval', 'results')
  await fs.mkdir(directory, { recursive: true })

  const payload = {
    generatedAt: new Date().toISOString(),
    mode,
    fixture: fixture ?? null,
    results,
  }

  await fs.writeFile(path.join(directory, 'latest.json'), JSON.stringify(payload, null, 2), 'utf8')
}

async function main() {
  const { dryRun, mode, fixture } = parseArgs(process.argv.slice(2))
  const scenarios = (await loadScenarios()).filter((scenario) => !fixture || scenario.id === fixture)
  if (scenarios.length === 0) throw new Error('No scenarios matched the requested fixture.')

  if (dryRun) {
    printDryRun(scenarios)
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('Set GROQ_API_KEY before running prompt evaluation.')

  const groq = new Groq({ apiKey })

  // Load any previously saved results so incremental runs accumulate
  const directory = path.join(process.cwd(), 'eval', 'results')
  let results: EvalResult[] = []
  try {
    const prior = JSON.parse(await fs.readFile(path.join(directory, 'latest.json'), 'utf8')) as { results: EvalResult[] }
    if (!fixture) results = prior.results ?? []
  } catch { /* no prior results */ }

  const completedIds = new Set(results.map((r) => r.scenarioId))
  const pending = scenarios.filter((s) => !completedIds.has(s.id))

  if (pending.length === 0) {
    console.log('All scenarios already evaluated. Delete eval/results/latest.json to re-run.')
    printResults(results)
    return
  }

  for (const scenario of pending) {
    console.log(`Evaluating ${scenario.id}...`)
    results.push(await evaluateScenario(groq, apiKey, scenario, mode))
    await persistResults(results, mode, fixture)
  }

  printResults(results)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
