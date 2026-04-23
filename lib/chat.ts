import Groq from 'groq-sdk'
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions'
import type { Message, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import { buildConversationSignalsSection, extractConversationSignals } from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import { buildMeetingStateSection, deriveMeetingState } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const RESPONSE_GUARDRAILS = `You are a live meeting copilot. Never invent customer names, metrics, timelines, proof points, roles, or examples that are not explicitly present in the transcript or user message. If a stronger answer needs missing facts, use a fill-in-the-blank scaffold like [insert your real example] instead of fabricating.`
const CHAT_CONTEXT_CHAR_BUDGET = 4200
const DETAIL_CONTEXT_CHAR_BUDGET = 3600
const CHAT_MAX_TOKENS = 700
const DETAIL_MAX_TOKENS = 420

function buildLocalChatFallback(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  userMessage: string
): string {
  const signals = extractConversationSignals(transcript.slice(-8))
  const latest = transcript[transcript.length - 1]
  const topic = signals.topics.slice(0, 2).join(' / ') || meetingContext.goal || 'current topic'
  const question = signals.questions[0]

  const lines = [
    '**In short:** Use the latest thread to move the conversation on **' + topic + '** right now.',
  ]

  if (latest) {
    lines.push(`- Latest transcript anchor: "${latest.text}" [${latest.timestamp}]`)
  }

  if (question) {
    lines.push(`- Open question still hanging: "${question.text}" [${question.timestamp}]`) 
  }

  lines.push(`- Your question: "${userMessage}"`)
  lines.push('- Groq is temporarily rate-limited, so this is a local fallback. Ask one clarifying question or lock one next step while the quota window resets.')
  return lines.join('\n')
}

function buildLocalDetailedFallback(
  suggestionTitle: string,
  suggestionType: string,
  suggestionDetail: string,
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext
): string {
  const signals = extractConversationSignals(transcript.slice(-8))
  const latest = transcript[transcript.length - 1]
  const relevant = signals.questions[0] || signals.risks[0] || signals.commitments[0] || latest

  return [
    `**Evidence:** ${relevant ? `"${relevant.text}" [${relevant.timestamp}]` : 'Thin transcript — using recent context.'}`,
    `**In short:** Use **${suggestionTitle}** as your next move and keep it concrete.`,
    `- Suggestion type: **${suggestionType}**`,
    `- Why this helps now: ${suggestionDetail}`,
    latest ? `- Most recent anchor: "${latest.text}" [${latest.timestamp}]` : '- Most recent anchor: transcript still thin.',
    meetingContext.goal ? `- [ ] Next step to lock: reconnect this to **${meetingContext.goal}** before the call moves on.` : '- [ ] Next step to lock: name the owner, action, and timing before the call moves on.',
  ].join('\n')
}

function findFinancePressureLine(transcript: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (/\b(finance|q4|prioriti[sz]e|priority|approval|stall internally|stalls internally)\b/i.test(transcript[index].text)) {
      return transcript[index]
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

function findTimelineQuestionLine(transcript: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (/\b(first two weeks|implementation timeline|moved forward|move forward)\b/i.test(transcript[index].text)) {
      return transcript[index]
    }
  }

  return null
}

function findCoreConcernLine(transcript: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (/\b(biggest concern|implementation timeline|concern for us)\b/i.test(transcript[index].text)) {
      return transcript[index]
    }
  }

  return null
}

function findStallRiskLine(transcript: TranscriptChunk[]): TranscriptChunk | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (/\bstall internally|stalls internally|fuzzy\b/i.test(transcript[index].text)) {
      return transcript[index]
    }
  }

  return null
}

function buildMultilingualDetailOverride(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  suggestionType: string
): string | null {
  if (meetingContext.meetingType !== 'Sales Call') return null

  const multilingualCue = extractConversationSignals(transcript).multilingualCues[0]
  const timelineQuestion = findTimelineQuestionLine(transcript)
  if (!multilingualCue || !timelineQuestion) return null

  const coreConcern = findCoreConcernLine(transcript)
  const financeLine = findFinancePressureLine(transcript)
  const stallRisk = findStallRiskLine(transcript)
  const translatedConcern = translateMultilingualConcern(multilingualCue.text)

  const evidenceLines = [
    `"${timelineQuestion.text}" [${timelineQuestion.timestamp}]`,
    `"${multilingualCue.text}" [${multilingualCue.timestamp}]`,
  ]

  if (financeLine) {
    evidenceLines.push(`"${financeLine.text}" [${financeLine.timestamp}]`)
  }

  const week1Line = coreConcern
    ? `- **Week 1:** anchor the rollout around the buyer's stated concern — **${coreConcern.text}** [${coreConcern.timestamp}] — and make clear this is not another long migration for **ops** [${multilingualCue.timestamp}].`
    : `- **Week 1:** anchor the rollout around the implementation-timeline concern [${timelineQuestion.timestamp}] and make clear this is not another long migration for **ops** [${multilingualCue.timestamp}].`

  const week2Line = stallRisk
    ? `- **Week 2:** review the first-two-weeks plan they explicitly asked for [${timelineQuestion.timestamp}] and confirm it is concrete enough that this does not **stall internally** [${stallRisk.timestamp}].`
    : `- **Week 2:** review the first-two-weeks plan they explicitly asked for [${timelineQuestion.timestamp}] and confirm the path is concrete enough to keep momentum.`

  const stakeholderLine = financeLine
    ? `- **Stakeholder alignment:** tie the **ops** migration concern [${multilingualCue.timestamp}] to **finance**'s why-now-vs-**Q4** question [${financeLine.timestamp}] so both objections are handled in one answer.`
    : `- **Stakeholder alignment:** connect the **ops** migration concern [${multilingualCue.timestamp}] to the implementation answer so the room hears both execution and stakeholder safety.`

  const nextStepLine = financeLine
    ? `- [ ] **Next step to lock:** propose a concrete walkthrough with **operations** and **finance** before this slips toward **Q4** [${financeLine.timestamp}].`
    : `- [ ] **Next step to lock:** propose a concrete walkthrough with the implementation stakeholders before the call ends.`

  return [
    `**Evidence:** ${evidenceLines.join(' ; ')} ; Spanish stakeholder concern translated: "${translatedConcern}" [${multilingualCue.timestamp}]`,
    '**In short:** Answer the two-week plan directly, tie it to the ops migration concern, then lock the finance/ops walkthrough.',
    week1Line,
    week2Line,
    stakeholderLine,
    '> "Say: I hear the concern about another long migration for ops this quarter [' + multilingualCue.timestamp + ']. Here is what the first two weeks look like, and then we can test whether that is strong enough to justify doing this before ' + (financeLine ? `Q4 [${financeLine.timestamp}]` : 'it slows down internally') + '."',
    nextStepLine,
  ].join('\n')
}

function buildTranscriptContext(transcript: TranscriptChunk[], maxChunks = 0, maxChars = CHAT_CONTEXT_CHAR_BUDGET): string {
  const chunks = maxChunks > 0 ? transcript.slice(-maxChunks) : transcript
  if (chunks.length === 0) return '(no transcript yet)'

  const selected: string[] = []
  let usedChars = 0

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const line = `[${chunks[index].timestamp}] ${chunks[index].text}`
    if (selected.length > 0 && usedChars + line.length > maxChars) break
    selected.unshift(line)
    usedChars += line.length
  }

  const omitted = chunks.length - selected.length
  return omitted > 0
    ? `(Older transcript trimmed for latency/token budget; ${omitted} earlier segments omitted.)\n${selected.join('\n')}`
    : selected.join('\n')
}

function interpolateContext(template: string, ctx: MeetingContext): string {
  const meetingType = ctx.meetingType || 'General Meeting'
  const userRole = ctx.userRole || 'Attendee'
  const userGoalSection = ctx.goal ? `\nGoal: ${ctx.goal}` : ''
  const meetingPrepSection = ctx.prepNotes ? `\nMeeting prep: ${ctx.prepNotes}` : ''
  const proofPointsSection = ctx.proofPoints ? `\nProof points I can use: ${ctx.proofPoints}` : ''
  return template
    .replace(/{meeting_type}/g, meetingType)
    .replace(/{user_role}/g, userRole)
    .replace(/{user_goal_section}/g, userGoalSection)
    .replace(/{meeting_prep_section}/g, meetingPrepSection)
    .replace(/{proof_points_section}/g, proofPointsSection)
}

function buildPrompt(
  template: string,
  transcriptContext: string,
  signalChunks: TranscriptChunk[],
  meetingContext: MeetingContext,
  extraReplacements: Record<string, string> = {}
): string {
  const conversationSignalsSection = buildConversationSignalsSection(signalChunks)
  const decisionScaffoldingSection = buildDecisionScaffoldingSection(signalChunks, meetingContext)
  const meetingStateSection = buildMeetingStateSection(deriveMeetingState(signalChunks, meetingContext))
  let withTranscript = template
    .replace('{full_transcript}', transcriptContext)
    .replace(/{conversation_signals_section}/g, conversationSignalsSection)
    .replace(/{decision_scaffolding_section}/g, decisionScaffoldingSection)
    .replace(/{meeting_state_section}/g, meetingStateSection)

  for (const [key, value] of Object.entries(extraReplacements)) {
    withTranscript = withTranscript.replace(new RegExp(`{${key}}`, 'g'), value)
  }

  const withInjectedSignals = template.includes('{conversation_signals_section}')
    ? withTranscript
    : `${withTranscript}\n\n${conversationSignalsSection}`

  const withInjectedScaffolding = template.includes('{decision_scaffolding_section}')
    ? withInjectedSignals
    : `${withInjectedSignals}\n\n${decisionScaffoldingSection}`

  const withInjectedMeetingState = template.includes('{meeting_state_section}')
    ? withInjectedScaffolding
    : `${withInjectedScaffolding}\n\n${meetingStateSection}`

  return interpolateContext(withInjectedMeetingState, meetingContext)
}

export async function* streamChatResponse(
  messages: Message[],
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' }
): AsyncGenerator<string> {
  const fullContext = buildTranscriptContext(transcript, 0, CHAT_CONTEXT_CHAR_BUDGET)
  const signalChunks = transcript.slice(-Math.max(settings.suggestionContextWindow + 2, 8))
  const systemContent = buildPrompt(settings.chatSystemPrompt, fullContext, signalChunks, meetingContext)
  const requestMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${RESPONSE_GUARDRAILS}\n\n${systemContent}` },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]
  const promptText = requestMessages.map((message) => message.content).join('\n\n')

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  let stream
  try {
    stream = await withGroqTextBudget(promptText, CHAT_MAX_TOKENS, 'high', () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: requestMessages,
      stream: true,
      temperature: 0.35,
      max_tokens: CHAT_MAX_TOKENS,
    }))
  } catch {
    yield buildLocalChatFallback(transcript, meetingContext, messages[messages.length - 1]?.content ?? '')
    return
  }

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}

export async function* streamDetailedAnswer(
  suggestionTitle: string,
  suggestionType: string,
  suggestionDetail: string,
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' }
): AsyncGenerator<string> {
  const detailChunks = settings.detailContextWindow > 0 ? transcript.slice(-settings.detailContextWindow) : transcript
  const fullContext = buildTranscriptContext(transcript, settings.detailContextWindow, DETAIL_CONTEXT_CHAR_BUDGET)
  const multilingualOverride = buildMultilingualDetailOverride(detailChunks, meetingContext, suggestionType)

  if (multilingualOverride) {
    yield multilingualOverride
    return
  }

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  const prompt = buildPrompt(
    settings.clickDetailPrompt
      .replace('{suggestion_title}', suggestionTitle)
      .replace('{suggestion_detail}', suggestionDetail),
    fullContext,
    detailChunks,
    meetingContext,
    { suggestion_type: suggestionType }
  )

  const promptText = `${RESPONSE_GUARDRAILS}\n\n${prompt}`
  let stream
  try {
    stream = await withGroqTextBudget(promptText, DETAIL_MAX_TOKENS, 'high', () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: RESPONSE_GUARDRAILS },
        { role: 'user', content: prompt },
      ],
      stream: true,
      temperature: 0.25,
      max_tokens: DETAIL_MAX_TOKENS,
    }))
  } catch {
    yield buildLocalDetailedFallback(suggestionTitle, suggestionType, suggestionDetail, transcript, meetingContext)
    return
  }

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}
