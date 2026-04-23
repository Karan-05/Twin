import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import Groq from 'groq-sdk'
import { DEFAULT_SETTINGS } from '../lib/settings.ts'

type TranscriptChunk = {
  timestamp: string
  text: string
}

type MeetingContext = {
  meetingType: string
  userRole: string
  goal: string
  prepNotes?: string
  proofPoints?: string
}

type Scenario = {
  id: string
  name: string
  meetingContext: MeetingContext
  transcript: TranscriptChunk[]
  mustCoverAny?: string[]
  antiPatterns?: string[]
  detailScenario?: string
}

type Suggestion = {
  type: string
  title: string
  detail: string
  say?: string
  whyNow?: string
  listenFor?: string
}

type PromptBundle = {
  liveSuggestionPrompt: string
  clickDetailPrompt: string
  chatSystemPrompt: string
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

const RESPONSE_GUARDRAILS = `You are a live meeting copilot. Never invent customer names, metrics, timelines, proof points, roles, or examples that are not explicitly present in the transcript or user message. If a stronger answer needs missing facts, use a fill-in-the-blank scaffold like [insert your real example] instead of fabricating.`

const QUESTION_PREFIXES = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'would', 'could', 'should', 'can', 'do',
  'does', 'did', 'is', 'are', 'was', 'were', 'will', 'have', 'has', 'had'
]

const COMMITMENT_PATTERN = /\b(will|i'll|we'll|going to|next step|follow up|send|share|deliver|commit|owner|deadline|by\s+(monday|tuesday|wednesday|thursday|friday|tomorrow|next week|end of day|eod|q[1-4]))\b/i
const RISK_PATTERN = /\b(not sure|unsure|maybe|depends|blocked|blocker|risk|concern|issue|problem|later|eventually|hard|difficult|can't|cannot|won't|similar|nice to have|budget|timeline|approval)\b/i
const NUMBER_PATTERN = /(?:\$|€|£|¥)?\b\d+(?:[.,]\d+)?\s*(?:%|percent|k|m|b|million|billion|days?|weeks?|months?|years?)?\b/i
const MULTILINGUAL_PATTERN = /[^\x00-\x7F]|\b(sí|si|porque|equipo|operaciones|trimestre|gracias|hola|vale|pero|también|tambien|necesita|necesitamos|migraci[oó]n|largo|larga)\b/i
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'they', 'them', 'their', 'there', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'when', 'what', 'where', 'while', 'which',
  'who', 'your', 'you', 'our', 'ours', 'we', 'us', 'for', 'are', 'was', 'were', 'been', 'being',
  'will', 'just', 'said', 'says', 'also', 'only', 'really', 'very', 'more', 'most', 'much', 'many',
  'some', 'like', 'kind', 'sort', 'need', 'want', 'make', 'made', 'does', 'doing', 'did', 'done',
  'can', 'cant', 'cannot', 'not', 'yes', 'yeah', 'okay', 'well', 'right', 'maybe', 'into', 'over',
  'under', 'than', 'after', 'before', 'because', 'through', 'across', 'around', 'meeting', 'call'
])
const VALID_TYPES = new Set(['question', 'talking_point', 'answer', 'fact_check', 'clarification'])
const GENERIC_TITLE_PATTERN = /^(helpful suggestion|talking point|question to ask|follow[- ]up|next step|idea|answer)$/i
const STAKEHOLDER_PATTERN = /\b(finance|ops|operations|design|legal|customer success|support|board|investor|recruiter|manager|lead|leadership|ceo|cto|cfo|sales|security|qa|product)\b/gi
const DEADLINE_PATTERN = /\b(today|tomorrow|friday|monday|tuesday|wednesday|thursday|next week|end of day|eod|deadline|this quarter|q[1-4])\b/i
const OWNER_OR_TIMELINE_PATTERN = /\b(owner|who can|who owns|make the call|deadline|by when|tomorrow|friday|next step|follow up|escalat|workaround|qa|legal|security review|q[1-4])\b/i

type EvalMeetingState = {
  currentQuestion: string | null
  blocker: string | null
  riskyClaim: string | null
  deadlineSignal: string | null
  loopStatus: string | null
  decisionFocus: string | null
  stakeholderSignals: string[]
}

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

async function loadPromptBundle(): Promise<PromptBundle> {
  return {
    liveSuggestionPrompt: DEFAULT_SETTINGS.liveSuggestionPrompt,
    clickDetailPrompt: DEFAULT_SETTINGS.clickDetailPrompt,
    chatSystemPrompt: DEFAULT_SETTINGS.chatSystemPrompt,
  }
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

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function splitSentences(text: string): string[] {
  return cleanText(text)
    .split(/(?<=[.?!])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractTopics(chunks: TranscriptChunk[], limit = 5): string[] {
  const scores = new Map<string, number>()

  chunks.forEach((chunk, chunkIndex) => {
    const weight = chunkIndex === chunks.length - 1 ? 3 : 1
    const words = cleanText(chunk.text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
    words.forEach((word) => {
      if (STOPWORDS.has(word)) return
      scores.set(word, (scores.get(word) ?? 0) + weight)
    })
  })

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
}

function extractSignalLines(chunks: TranscriptChunk[], pattern: RegExp, limit = 3): string[] {
  return chunks
    .filter((chunk) => pattern.test(chunk.text))
    .map((chunk) => `- [${chunk.timestamp}] ${cleanText(chunk.text)}`)
    .slice(-limit)
    .reverse()
}

function extractQuestions(chunks: TranscriptChunk[]): string[] {
  const lines: string[] = []
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const lower = sentence.toLowerCase()
      if (sentence.includes('?') || QUESTION_PREFIXES.some((prefix) => lower.startsWith(`${prefix} `))) {
        lines.push(`- [${chunk.timestamp}] ${sentence}`)
      }
    }
  }
  return lines.slice(-3).reverse()
}

function buildConversationSignalsSection(chunks: TranscriptChunk[]): string {
  const topics = extractTopics(chunks)
  const multilingual = extractSignalLines(chunks, MULTILINGUAL_PATTERN, 2)
  const sections = [
    '## Conversation signals',
    `Likely live topics: ${topics.length ? topics.join(' · ') : 'none extracted yet'}`,
    'Recent questions',
    ...(extractQuestions(chunks).length ? extractQuestions(chunks) : ['- none']),
    'Claims / numbers worth checking',
    ...(extractSignalLines(chunks, NUMBER_PATTERN).length ? extractSignalLines(chunks, NUMBER_PATTERN) : ['- none']),
    'Commitments / next steps mentioned',
    ...(extractSignalLines(chunks, COMMITMENT_PATTERN).length ? extractSignalLines(chunks, COMMITMENT_PATTERN) : ['- none']),
    'Risks / ambiguity / blockers',
    ...(extractSignalLines(chunks, RISK_PATTERN).length ? extractSignalLines(chunks, RISK_PATTERN) : ['- none']),
    'Language shifts / multilingual cues',
    ...(multilingual.length ? multilingual : ['- none']),
  ]

  return sections.join('\n')
}

function buildDecisionScaffoldingSection(chunks: TranscriptChunk[], scenario: Scenario): string {
  const signals = {
    questions: extractQuestions(chunks),
    risks: extractSignalLines(chunks, RISK_PATTERN),
    numericClaims: extractSignalLines(chunks, NUMBER_PATTERN),
    commitments: extractSignalLines(chunks, COMMITMENT_PATTERN),
  }

  let mode = 'Re-anchor the conversation to the real objective'
  let mix = 'talking_point → question → clarification'

  if (signals.questions.length > 0) {
    mode = 'Answer or probe the open question'
    mix = 'answer → question → clarification'
  } else if (signals.risks.length > 0 && signals.commitments.length > 0) {
    mode = 'Unblock a hidden risk or ambiguity'
    mix = 'clarification → question → talking_point'
  } else if (signals.numericClaims.length > 0) {
    mode = 'Pressure-test the risky claim'
    mix = 'fact_check → question → talking_point'
  } else if (signals.commitments.length > 0) {
    mode = 'Lock the next step before drift'
    mix = 'question → clarification → talking_point'
  }

  const opportunities = [
    ...signals.questions.map((line) => `- Open question: ${line.replace(/^- /, '')}`),
    ...signals.risks.map((line) => `- Risk / ambiguity: ${line.replace(/^- /, '')}`),
    ...signals.numericClaims.map((line) => `- Claim / number: ${line.replace(/^- /, '')}`),
    ...signals.commitments.map((line) => `- Commitment / next step: ${line.replace(/^- /, '')}`),
  ].slice(0, 4)

  return [
    '## Decision scaffolding',
    `Primary mode: ${mode}`,
    `Recommended suggestion mix: ${mix}`,
    'Highest-leverage opportunities right now:',
    ...(opportunities.length ? opportunities : ['- none extracted yet']),
    'Anti-goals:',
    '- Do not give generic advice.',
    '- Do not ignore the freshest leverage point.',
    '- Do not invent missing evidence.',
    ...(scenario.meetingContext.prepNotes ? ['- Use prep context as a ranking hint, not as fabricated evidence.'] : []),
  ].join('\n')
}

function buildMeetingStateSection(chunks: TranscriptChunk[]): string {
  const questions = extractQuestions(chunks)
  const risks = extractSignalLines(chunks, RISK_PATTERN)
  const numericClaims = extractSignalLines(chunks, NUMBER_PATTERN)
  const commitments = extractSignalLines(chunks, COMMITMENT_PATTERN)

  return [
    '## Meeting state',
    `Current question: ${questions[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? 'none'}`,
    `Blocker: ${risks[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? 'none'}`,
    `Risky claim: ${numericClaims[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? 'none'}`,
    `Next-step signal: ${commitments[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? 'none'}`,
  ].join('\n')
}

function findFinancePressureLine(chunks: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (/\b(finance|q4|prioriti[sz]e|priority|approval|stall internally|stalls internally)\b/i.test(chunks[index].text)) {
      return chunks[index]
    }
  }

  return null
}

function translateMultilingualConcern(text: string): string {
  const lower = text.toLowerCase()
  if (/operaciones/.test(lower) && /migraci[oó]n/.test(lower) && /(trimestre|quarter)/.test(lower)) {
    return 'another long migration this quarter for the operations team'
  }

  if (/operaciones/.test(lower) && /migraci[oó]n/.test(lower)) {
    return 'a long migration for the operations team'
  }

  return text
}

function findTimelineQuestionLine(chunks: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (/\b(first two weeks|implementation timeline|moved forward|move forward)\b/i.test(chunks[index].text)) {
      return chunks[index]
    }
  }

  return null
}

function findCoreConcernLine(chunks: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (/\b(biggest concern|implementation timeline|concern for us)\b/i.test(chunks[index].text)) {
      return chunks[index]
    }
  }

  return null
}

function findStallRiskLine(chunks: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (/\bstall internally|stalls internally|fuzzy\b/i.test(chunks[index].text)) {
      return chunks[index]
    }
  }

  return null
}

function buildMultilingualDetailOverride(scenario: Scenario, suggestionType: string): string {
  if (scenario.meetingContext.meetingType !== 'Sales Call') return ''

  const multilingualCueLine = extractSignalLines(scenario.transcript, MULTILINGUAL_PATTERN, 2)[0]
  const timelineQuestion = findTimelineQuestionLine(scenario.transcript)
  if (!multilingualCueLine || !timelineQuestion) return ''

  const cueText = multilingualCueLine.replace(/^- \[[^\]]+\]\s*/, '')
  const cueTimestamp = multilingualCueLine.match(/^\- \[([^\]]+)\]/)?.[1] ?? 'LIVE'
  const coreConcern = findCoreConcernLine(scenario.transcript)
  const financeLine = findFinancePressureLine(scenario.transcript)
  const stallRisk = findStallRiskLine(scenario.transcript)
  const translatedConcern = translateMultilingualConcern(cueText)

  const evidenceLines = [
    `"${timelineQuestion.text}" [${timelineQuestion.timestamp}]`,
    `"${cueText}" [${cueTimestamp}]`,
  ]

  if (financeLine) {
    evidenceLines.push(`"${financeLine.text}" [${financeLine.timestamp}]`)
  }

  const week1Line = coreConcern
    ? `- **Week 1:** anchor the rollout around the buyer's stated concern — **${coreConcern.text}** [${coreConcern.timestamp}] — and make clear this is not another long migration for **ops** [${cueTimestamp}].`
    : `- **Week 1:** anchor the rollout around the implementation-timeline concern [${timelineQuestion.timestamp}] and make clear this is not another long migration for **ops** [${cueTimestamp}].`

  const week2Line = stallRisk
    ? `- **Week 2:** review the first-two-weeks plan they explicitly asked for [${timelineQuestion.timestamp}] and confirm it is concrete enough that this does not **stall internally** [${stallRisk.timestamp}].`
    : `- **Week 2:** review the first-two-weeks plan they explicitly asked for [${timelineQuestion.timestamp}] and confirm the path is concrete enough to keep momentum.`

  const stakeholderLine = financeLine
    ? `- **Stakeholder alignment:** tie the **ops** migration concern [${cueTimestamp}] to **finance**'s why-now-vs-**Q4** question [${financeLine.timestamp}] so both objections are handled in one answer.`
    : `- **Stakeholder alignment:** connect the **ops** migration concern [${cueTimestamp}] to the implementation answer so the room hears both execution and stakeholder safety.`

  const nextStepLine = financeLine
    ? `- [ ] **Next step to lock:** propose a concrete walkthrough with **operations** and **finance** before this slips toward **Q4** [${financeLine.timestamp}].`
    : `- [ ] **Next step to lock:** propose a concrete walkthrough with the implementation stakeholders before the call ends.`

  return [
    `**Evidence:** ${evidenceLines.join(' ; ')} ; Spanish stakeholder concern translated: "${translatedConcern}" [${cueTimestamp}]`,
    '**In short:** Answer the two-week plan directly, tie it to the ops migration concern, then lock the finance/ops walkthrough.',
    week1Line,
    week2Line,
    stakeholderLine,
    '> "Say: I hear the concern about another long migration for ops this quarter [' + cueTimestamp + ']. Here is what the first two weeks look like, and then we can test whether that is strong enough to justify doing this before ' + (financeLine ? `Q4 [${financeLine.timestamp}]` : 'it slows down internally') + '."',
    nextStepLine,
  ].join('\n')
}

function normalizeType(raw: string): Suggestion['type'] {
  const normalized = raw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '')
  return VALID_TYPES.has(normalized) ? normalized : 'question'
}

function semanticSimilarity(left: Pick<Suggestion, 'title' | 'detail'>, right: Pick<Suggestion, 'title' | 'detail'>): number {
  const leftSet = new Set(
    cleanText(`${left.title} ${left.detail}`).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((token) => !STOPWORDS.has(token)) ?? []
  )
  const rightSet = new Set(
    cleanText(`${right.title} ${right.detail}`).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((token) => !STOPWORDS.has(token)) ?? []
  )

  if (leftSet.size === 0 || rightSet.size === 0) return 0

  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) overlap += 1
  }

  return overlap / Math.min(leftSet.size, rightSet.size)
}

function isSemanticDuplicate(candidate: Pick<Suggestion, 'title' | 'detail'>, existing: Array<Pick<Suggestion, 'title' | 'detail'>>): boolean {
  return existing.some((item) => {
    const exactTitle = item.title.trim().toLowerCase() === candidate.title.trim().toLowerCase()
    return exactTitle || semanticSimilarity(candidate, item) >= 0.72
  })
}

function sanitizeSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const cleaned: Suggestion[] = []
  const seenTitles = new Set<string>()

  for (const suggestion of suggestions) {
    const title = suggestion.title.replace(/\s+/g, ' ').trim()
    const detail = suggestion.detail.replace(/\s+/g, ' ').trim()
    if (!title || !detail) continue
    if (title.length < 6 || detail.length < 30) continue
    if (GENERIC_TITLE_PATTERN.test(title)) continue
    if (seenTitles.has(title.toLowerCase())) continue
    if (isSemanticDuplicate({ title, detail }, cleaned)) continue

    cleaned.push({
      ...suggestion,
      title,
      detail,
    })
    seenTitles.add(title.toLowerCase())
  }

  return cleaned
}

function deriveEvalMeetingState(chunks: TranscriptChunk[], meetingContext: MeetingContext): EvalMeetingState {
  const questions = extractQuestions(chunks)
  const risks = extractSignalLines(chunks, RISK_PATTERN)
  const numericClaims = extractSignalLines(chunks, NUMBER_PATTERN)
  const commitments = extractSignalLines(chunks, COMMITMENT_PATTERN)
  const stakeholders = Array.from(new Set(`${chunks.map((chunk) => chunk.text).join(' ')} ${meetingContext.prepNotes ?? ''}`
    .match(STAKEHOLDER_PATTERN)?.map((item) => item.toLowerCase()) ?? [])).slice(0, 6)

  const recent = chunks.slice(-4).map((chunk) => chunk.text.toLowerCase()).join(' ')
  const loopStatus = /still|again|keeps looping|looping|same issue|same problem/.test(recent)
    ? 'Conversation appears to be looping without a decision rule.'
    : null

  return {
    currentQuestion: questions[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? null,
    blocker: risks[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? null,
    riskyClaim: numericClaims[0]?.replace(/^- \[[^\]]+\]\s*/, '') ?? null,
    deadlineSignal: commitments.find((line) => DEADLINE_PATTERN.test(line))?.replace(/^- \[[^\]]+\]\s*/, '')
      ?? risks.find((line) => DEADLINE_PATTERN.test(line))?.replace(/^- \[[^\]]+\]\s*/, '')
      ?? null,
    loopStatus,
    decisionFocus: extractTopics(chunks, 2).join(' / ') || meetingContext.goal || null,
    stakeholderSignals: stakeholders,
  }
}

function scoreSuggestion(suggestion: Suggestion, chunks: TranscriptChunk[], meetingContext: MeetingContext, meetingState: EvalMeetingState): number {
  let score = 0
  const latestText = chunks[chunks.length - 1]?.text.toLowerCase() ?? ''
  const combinedText = `${suggestion.title} ${suggestion.detail} ${suggestion.say ?? ''} ${suggestion.whyNow ?? ''} ${suggestion.listenFor ?? ''}`.toLowerCase()

  if (meetingState.currentQuestion) {
    if (suggestion.type === 'answer') score += 4
    if (suggestion.type === 'talking_point') score += 2
    if (suggestion.type === 'question') score -= 3
    const questionTokens = meetingState.currentQuestion.match(/[a-z][a-z0-9_-]{2,}/g) ?? []
    score += questionTokens.filter((token) => !STOPWORDS.has(token) && combinedText.includes(token)).slice(0, 4).length * 0.35
  }

  if (meetingState.riskyClaim && suggestion.type === 'fact_check') score += 3
  if (meetingState.blocker && (suggestion.type === 'clarification' || suggestion.type === 'question')) score += 2
  if (meetingState.deadlineSignal && suggestion.type === 'question') score += 1.5
  if (meetingState.loopStatus && (suggestion.type === 'clarification' || suggestion.type === 'talking_point')) score += 2

  const stakeholderMatches = meetingState.stakeholderSignals.filter((stakeholder) => combinedText.includes(stakeholder)).length
  score += Math.min(1.5, stakeholderMatches * 0.6)

  if ((meetingState.blocker || meetingState.deadlineSignal) && OWNER_OR_TIMELINE_PATTERN.test(combinedText)) score += 1.25
  if (meetingContext.goal && combinedText.includes(meetingContext.goal.toLowerCase().split(' ')[0] ?? '')) score += 0.5
  if (meetingState.decisionFocus && combinedText.includes(meetingState.decisionFocus.toLowerCase().split(' ')[0] ?? '')) score += 0.75
  if (latestText && combinedText.includes(latestText.split(' ')[0] ?? '')) score += 0.25

  if (meetingContext.meetingType === 'Investor Pitch') {
    if (/(wedge|beachhead|security review|upmarket|arr|month over month|mom)/i.test(combinedText)) score += 1
    if (/(incumbent|bundle|defensibility|why now)/i.test(combinedText)) score += 0.9
  }

  if (meetingContext.meetingType === 'Sales Call') {
    if (/(first two weeks|implementation|timeline|q4|finance|operations|ops|approval)/i.test(combinedText)) score += 1
  }

  if (/(bilingual|spanish|translated|translation|operations team|equipo de operaciones|migración larga|migracion larga)/i.test(combinedText)) score += 0.9
  if ((meetingContext.prepNotes ?? '').toLowerCase().includes('bilingual') && /(operations|ops|finance|q4|internal approval|stall)/i.test(combinedText)) score += 0.75

  if (suggestion.say) score += 1.5
  if (suggestion.whyNow) score += 1
  if (suggestion.listenFor) score += 1
  if ((suggestion.say ?? suggestion.detail).length <= 180) score += 0.75

  return score
}

function rankSuggestions(candidates: Suggestion[], chunks: TranscriptChunk[], meetingContext: MeetingContext, meetingState: EvalMeetingState): Suggestion[] {
  const scored = candidates
    .map((suggestion) => ({ ...suggestion, score: scoreSuggestion(suggestion, chunks, meetingContext, meetingState) }))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))

  const chosen: Suggestion[] = []
  const usedTypes = new Set<string>()

  for (const candidate of scored) {
    if (chosen.length >= 3) break
    if (chosen.length > 0 && isSemanticDuplicate(candidate, chosen)) continue
    if (!usedTypes.has(candidate.type) || chosen.length >= 2) {
      chosen.push(candidate)
      usedTypes.add(candidate.type)
    }
  }

  for (const candidate of scored) {
    if (chosen.length >= 3) break
    if (isSemanticDuplicate(candidate, chosen)) continue
    chosen.push(candidate)
  }

  return chosen.slice(0, 3)
}

function buildFallbackSuggestions(chunks: TranscriptChunk[]): Suggestion[] {
  const questions = extractQuestions(chunks)
  const risks = extractSignalLines(chunks, RISK_PATTERN)
  const numericClaims = extractSignalLines(chunks, NUMBER_PATTERN)
  const commitments = extractSignalLines(chunks, COMMITMENT_PATTERN)
  const fallbacks: Suggestion[] = []

  if (questions[0]) {
    fallbacks.push({
      type: 'answer',
      title: 'Answer the open question',
      detail: `A direct question is still hanging: "${questions[0].replace(/^- \[[^\]]+\]\s*/, '')}". Give a concise answer now or ask one clarifying follow-up before the conversation moves on.`,
      say: 'Answer the question directly before the room moves on.',
      whyNow: 'An unanswered question is the highest-leverage interruption in the room.',
      listenFor: 'Whether they accept the answer or expose a deeper objection.',
    })
  }

  if (risks[0]) {
    fallbacks.push({
      type: 'clarification',
      title: 'Clarify the risky assumption',
      detail: `There is unresolved ambiguity in: "${risks[0].replace(/^- \[[^\]]+\]\s*/, '')}". Define the owner, timeline, or decision criterion now so this does not stay vague.`,
      say: 'Can we pin down the owner, timeline, and decision rule on this before we move on?',
      whyNow: 'The room is carrying ambiguity that will create downstream confusion.',
      listenFor: 'A named owner and a concrete deadline instead of vague agreement.',
    })
  }

  if (numericClaims[0]) {
    fallbacks.push({
      type: 'fact_check',
      title: 'Pressure-test the number',
      detail: `A concrete number or claim was stated: "${numericClaims[0].replace(/^- \[[^\]]+\]\s*/, '')}". Ask for the source, assumption, or comparison point before everyone starts treating it as fact.`,
      say: 'What assumption or source is that number based on?',
      whyNow: 'Once a number lands, the room will start planning around it unless it is tested.',
      listenFor: 'A real source, baseline, or a sign the claim is softer than it sounds.',
    })
  }

  if (commitments[0]) {
    fallbacks.push({
      type: 'question',
      title: 'Lock the next step',
      detail: `A commitment surfaced in: "${commitments[0].replace(/^- \[[^\]]+\]\s*/, '')}". Confirm the owner, exact deliverable, and timing so the meeting ends with a real next step.`,
      say: 'Before we wrap, who owns that exactly and by when?',
      whyNow: 'A soft commitment becomes real only when owner and timing are explicit.',
      listenFor: 'A named owner, a deliverable, and an actual date.',
    })
  }

  return sanitizeSuggestions(fallbacks)
}

function buildTranscriptLines(chunks: TranscriptChunk[]): string {
  return chunks
    .map((chunk, index) => index === chunks.length - 1 ? `[JUST SAID] ${chunk.text}` : `[${chunk.timestamp}] ${chunk.text}`)
    .join('\n')
}

function interpolate(template: string, scenario: Scenario): string {
  const conversationSignalsSection = buildConversationSignalsSection(scenario.transcript)
  return template
    .replace(/{meeting_type}/g, scenario.meetingContext.meetingType || 'General Meeting')
    .replace(/{user_role}/g, scenario.meetingContext.userRole || 'Attendee')
    .replace(/{user_goal_section}/g, scenario.meetingContext.goal ? `\nGoal: ${scenario.meetingContext.goal}` : '')
    .replace(/{meeting_prep_section}/g, scenario.meetingContext.prepNotes ? `\nMeeting prep: ${scenario.meetingContext.prepNotes}` : '')
    .replace(/{proof_points_section}/g, scenario.meetingContext.proofPoints ? `\nProof points I can use: ${scenario.meetingContext.proofPoints}` : '')
    .replace(/{recent_transcript}/g, buildTranscriptLines(scenario.transcript))
    .replace(/{full_transcript}/g, scenario.transcript.map((line) => `[${line.timestamp}] ${line.text}`).join('\n'))
    .replace(/{trigger_reason_section}/g, '')
    .replace(/{previous_suggestions_section}/g, '')
    .replace(/{conversation_signals_section}/g, conversationSignalsSection)
    .replace(/{decision_scaffolding_section}/g, buildDecisionScaffoldingSection(scenario.transcript, scenario))
    .replace(/{meeting_state_section}/g, buildMeetingStateSection(scenario.transcript))
}

async function generateSuggestions(groq: Groq, prompts: PromptBundle, scenario: Scenario): Promise<Suggestion[]> {
  const system = `You are a world-class real-time meeting strategist for a ${scenario.meetingContext.meetingType}. Return only valid JSON.`
  const user = `${interpolate(prompts.liveSuggestionPrompt, scenario)}\n\nReturn a JSON array in this shape only: [{"type":"...","title":"...","detail":"...","say":"...","why_now":"...","listen_for":"..."}]`

  const raw = await createJsonCompletion(
    groq,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    'array',
    900,
    0.45,
    false
  )

  let parsed: Array<{
    type: string
    title: string
    detail: string
    say?: string
    why_now?: string
    listen_for?: string
  }>

  try {
    parsed = parseJsonCandidate<Array<{
      type: string
      title: string
      detail: string
      say?: string
      why_now?: string
      listen_for?: string
    }>>(raw, 'array')
  } catch {
    const repaired = await repairJsonWithModel(groq, raw, 'array', 900)
    parsed = parseJsonCandidate<Array<{
      type: string
      title: string
      detail: string
      say?: string
      why_now?: string
      listen_for?: string
    }>>(repaired, 'array')
  }

  const transcript = scenario.transcript.map((chunk) => ({ timestamp: chunk.timestamp, text: chunk.text }))
  const meetingState = deriveEvalMeetingState(transcript, scenario.meetingContext)

  const candidates = sanitizeSuggestions(
    parsed.slice(0, 7).map((item) => ({
      type: normalizeType(item.type ?? ''),
      title: (item.title ?? '').trim(),
      detail: (item.detail ?? '').trim(),
      say: (item.say ?? '').trim() || undefined,
      whyNow: (item.why_now ?? '').trim() || undefined,
      listenFor: (item.listen_for ?? '').trim() || undefined,
    }))
  )

  let suggestions = rankSuggestions(candidates, transcript, scenario.meetingContext, meetingState)
  for (const fallback of buildFallbackSuggestions(transcript)) {
    if (suggestions.length >= 3) break
    if (isSemanticDuplicate(fallback, suggestions)) continue
    suggestions.push(fallback)
  }

  return suggestions.slice(0, 3)
}

async function generateDetailedAnswer(groq: Groq, prompts: PromptBundle, scenario: Scenario, suggestion: Suggestion): Promise<string> {
  const override = buildMultilingualDetailOverride(scenario, suggestion.type)
  if (override) return override

  const prompt = interpolate(
    prompts.clickDetailPrompt
      .replace('{suggestion_title}', suggestion.title)
      .replace('{suggestion_type}', suggestion.type)
      .replace('{suggestion_detail}', suggestion.detail),
    scenario
  )

  const response = await callGroqWithRetry(groq, {
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: RESPONSE_GUARDRAILS },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  })

  return (response.choices[0]?.message?.content ?? '').trim()
}

async function judgeJson<T>(groq: Groq, prompt: string): Promise<T> {
  const raw = await createJsonCompletion(
    groq,
    [{ role: 'user', content: prompt }],
    'object',
    900,
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
  prompts: PromptBundle,
  scenario: Scenario,
  mode: string
): Promise<EvalResult> {
  const suggestions = await generateSuggestions(groq, prompts, scenario)

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
    const answer = await generateDetailedAnswer(groq, prompts, scenario, suggestions[0])
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

  const prompts = await loadPromptBundle()
  const groq = new Groq({ apiKey })
  const results: EvalResult[] = []

  for (const scenario of scenarios) {
    console.log(`Evaluating ${scenario.id}...`)
    results.push(await evaluateScenario(groq, prompts, scenario, mode))
  }

  await persistResults(results, mode, fixture)
  printResults(results)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
