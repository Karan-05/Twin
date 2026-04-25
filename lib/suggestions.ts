import Groq from 'groq-sdk'
import { generateId, formatTimestamp } from './utils'
import { withRetry } from './retry'
import type { Suggestion, SuggestionBatch, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import {
  buildConversationSignalsSection,
  extractConversationSignals,
  extractPrimaryTopic,
  inferQuestionCategory,
  inferQuestionIntent,
  selectActionableQuestion,
} from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import type { MeetingState } from './meetingState'
import { buildMeetingStateSection } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const VALID_TYPES = new Set(['question', 'talking_point', 'answer', 'fact_check', 'clarification'])
const OWNER_OR_TIMELINE_PATTERN = /\b(owner|who can|who owns|make the call|deadline|by when|tomorrow|friday|next step|follow up|escalat|workaround|qa|legal|security review|q[1-4])\b/i
const SUGGESTION_MAX_TOKENS = 900


// Meeting-type-aware guidance without domain-fixed few-shots
const MEETING_PERSONAS: Record<string, string> = {
  'Sales Call': 'You are a real-time commercial advisor. Help the participant answer direct buyer questions, surface hidden buying constraints, and turn vague interest into a concrete next move without drifting into a generic pitch.',
  'Job Interview': 'You are a high-signal interview coach. Help the participant answer directly with specific evidence, clear structure, and one speakable opener line they can use immediately.',
  'Investor Pitch': 'You are a rigorous strategic advisor. Keep answers grounded in evidence, sharpen assumptions, and convert broad claims into clear trade-offs, proof, or next decisions.',
  'Customer Discovery': 'You are a truth-seeking discovery coach. Surface pain, current behavior, ownership, urgency, and what is still only polite interest.',
  'Standup': 'You are a sharp delivery coach. Surface blockers, dependencies, owners, and what will slip if ambiguity remains unresolved.',
  '1:1': 'You are a concise coaching partner. Turn vague emotion or feedback into something observable, specific, and safe enough to address directly.',
  'Brainstorm': 'You are a focused facilitator. Keep idea generation useful by naming the decision rule, the strongest option, or the missing constraint before the room sprawls.',
  'Board Meeting': 'You are a board-level strategist. Push discussion toward leverage, risk, strategic trade-offs, and explicit ownership instead of drifting into update mode.',
  'Team Review': 'You are an accountability-focused review lead. Translate issues into outcomes, patterns, named owners, and concrete interventions.',
}

const DEFAULT_PERSONA = `You are a world-class real-time meeting strategist embedded with the participant. You surface only the highest-leverage moves — hyper-specific to what was JUST said, never generic. You always output valid JSON and nothing else.`

const STRICT_PREFIX = 'Output ONLY a valid JSON array. No markdown, no explanation, no preamble.\n\n'
const GENERIC_TITLE_PATTERN = /^(what are the key next steps|next steps|follow up|clarify|ask a question|helpful suggestion)$/i
const PLACEHOLDER_PATTERN = /\[[A-Za-z][^[\]]*\]|latest topic|current topic|your specific takeaway|next step\]|what matters most is(?:…|\.{3}|$)|the key point here is(?:…|\.{3}|$)|here'?s the direct answer(?:\s+on\s+[^:]+)?:?\s*(?:what matters most is)?(?:…|\.{3}|$)/i
const SEMANTIC_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'your', 'their', 'they', 'them', 'about', 'into',
  'what', 'when', 'where', 'which', 'would', 'could', 'should', 'will', 'just', 'really', 'very',
  'have', 'been', 'were', 'being', 'then', 'than', 'because', 'there', 'here', 'need', 'needs',
  'ask', 'asks', 'asking', 'question', 'point', 'talking', 'clarify', 'clarification', 'answer',
  'fact', 'check', 'next', 'step', 'steps', 'this', 'that', 'right', 'now', 'meeting', 'call'
])

interface SuggestionGenerationOptions {
  liveTranscriptPreview?: string
  meetingState?: MeetingState
  triggerReason?: string
}

function buildSystemPersona(meetingType: string): string {
  return (MEETING_PERSONAS[meetingType] ?? DEFAULT_PERSONA) +
    '\n\nYou always output valid JSON and nothing else.'
}

function normalizeType(raw: string): Suggestion['type'] {
  const normalized = raw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '')
  return VALID_TYPES.has(normalized) ? (normalized as Suggestion['type']) : 'question'
}

function compactTopic(topic?: string | null): string {
  if (!topic) return 'this topic'
  return topic.length > 28 ? `${topic.slice(0, 25).trimEnd()}…` : topic
}

type QuestionAxis =
  | 'timing'
  | 'scope'
  | 'configuration'
  | 'comparison'
  | 'tradeoff'
  | 'implementation'
  | 'evidence'
  | 'general'

function inferQuestionAxis(text: string, category: ReturnType<typeof inferQuestionCategory>): QuestionAxis {
  const lower = text.toLowerCase()
  if (/\bwhen\b|\btimeline\b|\bdeadline\b|\blead time\b|\barrival\b|\bship|deliver/i.test(lower)) return 'timing'
  if (/\bhow many\b|\bquantity\b|\bsize\b|\bscope\b|\bcount\b|\bnumber of\b/i.test(lower)) return 'scope'
  if (/\bconfig\b|\bconfiguration\b|\bcustom\b|\bcustomization\b|\bsetup\b|\boption\b|\bvariant\b|\bsoftware\b|\binstall\b/i.test(lower)) return 'configuration'
  if (/\bcompare\b|\bvs\b|\bversus\b|\bdifference\b|\bbetter\b/i.test(lower)) return 'comparison'
  if (/\btradeoff\b|\btrade-off\b|\bpros and cons\b|\bdownside\b|\bupside\b/i.test(lower)) return 'tradeoff'
  if (/\bproof\b|\bevidence\b|\bsource\b|\bcitation\b|\bdata\b/i.test(lower)) return 'evidence'
  if (category === 'implementation') return 'implementation'
  return 'general'
}

function buildAxisAwareAnswer(topic: string, axis: QuestionAxis, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (axis) {
    case 'timing':
      return `The direct answer on ${topic} should state the timing, the dependency that could change it, and the next fact needed to confirm it.`
    case 'scope':
      return `The direct answer on ${topic} should state the scope first, then whether one setup fits all cases or a split is needed.`
    case 'configuration':
      return `The direct answer on ${topic} should separate the standard path from optional configuration choices that change the recommendation.`
    case 'comparison':
      return `The cleanest answer on ${topic} is to compare it on one axis first, then add the consequence of that difference.`
    case 'tradeoff':
      return `The right answer on ${topic} is the main trade-off, then which side matters more in this conversation.`
    case 'implementation':
      return `The right answer on ${topic} is what happens first, where friction appears, and what needs to be true for rollout to work.`
    case 'evidence':
      return `The direct answer on ${topic} should separate the claim from the evidence behind it and state what still needs verification.`
    default:
      return buildKnowledgeSay(topic, category)
  }
}

function buildAxisAwareTalkingPoint(topic: string, axis: QuestionAxis): { title: string; detail: string; say: string; listenFor: string } {
  switch (axis) {
    case 'timing':
      return {
        title: 'Name the timing dependency',
        detail: 'Separate the headline answer from the one dependency that could move it. That keeps the answer concrete without overcommitting.',
        say: `The key thing to add on ${topic} is the dependency that changes the timing, not just the timing itself.`,
        listenFor: 'Which dependency is fixed and which one is still variable.',
      }
    case 'scope':
      return {
        title: 'Separate the scope',
        detail: 'Do not let one broad number hide real variation. Split the scope into the main groups or cases that matter.',
        say: `The useful way to answer ${topic} is to separate the main groups or use cases, not assume one size fits all.`,
        listenFor: 'Whether one answer fits all cases or the topic needs segmentation.',
      }
    case 'configuration':
      return {
        title: 'Separate standard from optional',
        detail: 'Frame the default path separately from optional configuration choices. That makes the recommendation easier to act on.',
        say: `The useful way to answer ${topic} is to separate the standard path from the optional choices that change the decision.`,
        listenFor: 'Whether they need the standard path or a non-default option.',
      }
    case 'comparison':
      return {
        title: `Name the ${topic} tradeoff`,
        detail: 'Move beyond description into the practical difference or consequence. That is what makes the answer useful in a live conversation.',
        say: `The key thing to add on ${topic} is the practical difference that should drive the decision.`,
        listenFor: 'Which side of the difference matters most to them.',
      }
    case 'tradeoff':
      return {
        title: `Name the ${topic} tradeoff`,
        detail: 'Move beyond description into the practical trade-off or decision consequence. That is what makes the answer useful in a live conversation.',
        say: `The key thing to add on ${topic} is the trade-off or decision consequence, not just the definition.`,
        listenFor: 'Which side of the trade-off or implication they care about most.',
      }
    case 'implementation':
      return {
        title: 'Name the rollout constraint',
        detail: 'Highlight the one constraint or bottleneck that will decide whether execution is smooth or painful.',
        say: `The key thing to add on ${topic} is the constraint that will make the rollout easy or hard in practice.`,
        listenFor: 'The bottleneck or dependency that will shape execution.',
      }
    case 'evidence':
      return {
        title: 'Separate the claim from proof',
        detail: 'If the room is relying on a claim, identify what evidence is solid and what is still assumption.',
        say: `The key thing to add on ${topic} is what we know for sure versus what still needs evidence.`,
        listenFor: 'Whether they have proof, a source, or just a working assumption.',
      }
    default:
      return {
        title: `Name the ${topic} tradeoff`,
        detail: 'Move beyond definition into the practical trade-off or decision consequence. That is what makes the answer useful in a live conversation.',
        say: `The key thing to add on ${topic} is the trade-off or decision consequence, not just the definition.`,
        listenFor: 'Which side of the trade-off or implication they care about most.',
      }
  }
}

function buildAxisAwareQuestion(topic: string, axis: QuestionAxis): { title: string; detail: string; say: string; listenFor: string } {
  switch (axis) {
    case 'timing':
      return {
        title: `Clarify ${topic} timing`,
        detail: 'Ask which dependency actually controls the timing so the answer can be specific without bluffing.',
        say: `What dependency controls the timing on ${topic} here — stock, approval, setup, or something else?`,
        listenFor: 'The one variable that actually changes the answer.',
      }
    case 'scope':
      return {
        title: `Clarify ${topic} scope`,
        detail: 'Ask whether one answer applies everywhere or whether the room is really talking about multiple cases.',
        say: `Does one answer cover all of ${topic} here, or should we split it by the main cases or users?`,
        listenFor: 'Whether the answer needs segmentation rather than one broad number or statement.',
      }
    case 'configuration':
      return {
        title: `Clarify ${topic} options`,
        detail: 'Ask which option or configuration actually matters so the answer stays tied to the real decision.',
        say: `Which option or configuration matters most on ${topic} here — the standard path or a non-default one?`,
        listenFor: 'The option that should drive the recommendation.',
      }
    case 'comparison':
      return {
        title: `Clarify ${topic} criteria`,
        detail: 'Ask which comparison axis matters most so the answer stays useful instead of wandering across too many dimensions.',
        say: `Which comparison axis matters most for ${topic} here — quality, cost, speed, risk, or fit?`,
        listenFor: 'The single criterion that should shape the answer.',
      }
    case 'tradeoff':
      return {
        title: `Clarify ${topic} priority`,
        detail: 'Ask which side of the trade-off matters more so the answer can recommend a direction instead of just describing both sides.',
        say: `Which side of the ${topic} trade-off matters more here?`,
        listenFor: 'The priority that should break the tie.',
      }
    case 'implementation':
      return {
        title: `Clarify ${topic} constraints`,
        detail: 'Ask one narrow follow-up only if it would materially change the answer — for example scale, version, workflow, or timing.',
        say: `What constraint matters most for ${topic} here — scale, version, workflow, or timing?`,
        listenFor: 'The one variable that should shape the deeper answer.',
      }
    case 'evidence':
      return {
        title: `Clarify ${topic} evidence`,
        detail: 'Ask what evidence or source the room is relying on so the answer does not quietly rest on an unsupported assumption.',
        say: `What evidence or source are we relying on for ${topic} here?`,
        listenFor: 'Whether the answer rests on evidence, precedent, or assumption.',
      }
    default:
      return {
        title: `Clarify ${topic} constraints`,
        detail: 'Ask one narrow follow-up only if it would materially change the answer — for example scale, version, workflow, or timing.',
        say: `What constraint matters most for ${topic} here — scale, version, workflow, or timing?`,
        listenFor: 'The one variable that should shape the deeper answer.',
      }
  }
}

function buildKnowledgeSay(topic: string, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (category) {
    case 'definition':
      return `${topic} should be answered by saying what it is first, then why it matters in practice.`
    case 'mechanism':
      return `The clearest answer on ${topic} is the path from input to output, plus the main trade-off.`
    case 'comparison':
      return `The cleanest answer on ${topic} is to compare it on one axis first — quality, cost, speed, or fit.`
    case 'reason':
      return `The useful answer on ${topic} is why it matters, what changes because of it, and what decision it should influence.`
    case 'tradeoff':
      return `The right answer on ${topic} is the main trade-off, then which side matters more here.`
    case 'implementation':
      return `The right answer on ${topic} is what happens first, where the friction appears, and what must be true for rollout to work.`
    case 'location':
      return `The direct answer on ${topic} is the location first, then why that location matters here.`
    case 'person':
      return `The direct answer on ${topic} is who the person is, then why they matter here.`
    case 'timing':
      return `The direct answer on ${topic} is the timing itself, then what that timing changes.`
    default:
      return `The direct answer on ${topic} should come first, then the one implication that matters here.`
  }
}

function buildTranscriptLines(chunks: TranscriptChunk[]): string {
  return chunks
    .map((c, i) =>
      i === chunks.length - 1
        ? `[JUST SAID] ${c.text}`
        : `[${c.timestamp}] ${c.text}`
    )
    .join('\n')
}

function buildPreviousSuggestionsSection(previousBatches: SuggestionBatch[]): string {
  if (previousBatches.length === 0) return ''
  const titles = previousBatches
    .flatMap((b) => b.suggestions.map((s) => `- "${s.title}"`))
    .slice(0, 6)
  return `## Previous suggestions — do NOT repeat these\n${titles.join('\n')}`
}

function buildUserMessage(
  settings: AppSettings,
  recentChunks: TranscriptChunk[],
  ctx: MeetingContext,
  previousBatches: SuggestionBatch[],
  priorMeetingContext?: string,
  options: SuggestionGenerationOptions = {}
): string {
  const meetingType = ctx.meetingType || 'General Meeting'
  const userRole = ctx.userRole || 'Attendee'
  const userGoalSection = ctx.goal ? `\nGoal: ${ctx.goal}` : ''
  const meetingPrepSection = ctx.prepNotes ? `\nMeeting prep: ${ctx.prepNotes}` : ''
  const proofPointsSection = ctx.proofPoints ? `\nProof points I can use: ${ctx.proofPoints}` : ''
  const triggerReasonSection = options.triggerReason ? `\nTrigger reason: ${options.triggerReason}` : ''
  const previousSuggestionsSection = buildPreviousSuggestionsSection(previousBatches)
  const previewChunk = options.liveTranscriptPreview?.trim()
    ? [{ id: 'live-preview', text: options.liveTranscriptPreview.trim(), timestamp: 'LIVE' } satisfies TranscriptChunk]
    : []
  const promptChunks = [...recentChunks, ...previewChunk]
  const recentTranscript = buildTranscriptLines(promptChunks)
  const conversationSignalsSection = buildConversationSignalsSection(promptChunks)
  const decisionScaffoldingSection = buildDecisionScaffoldingSection(promptChunks, ctx)
  const meetingStateSection = buildMeetingStateSection(
    options.meetingState ?? {
      mode: 'probe',
      currentQuestion: null,
      questionIntent: null,
      blocker: null,
      riskyClaim: null,
      decisionFocus: null,
      deadlineSignal: null,
      loopStatus: null,
      stakeholderSignals: [],
      triggerReason: null,
      updatedAt: null,
    }
  )

  let msg = settings.liveSuggestionPrompt
    .replace(/{meeting_type}/g, meetingType)
    .replace(/{user_role}/g, userRole)
    .replace(/{user_goal_section}/g, userGoalSection)
    .replace(/{meeting_prep_section}/g, meetingPrepSection)
    .replace(/{proof_points_section}/g, proofPointsSection)
    .replace(/{trigger_reason_section}/g, triggerReasonSection)
    .replace(/{previous_suggestions_section}/g, previousSuggestionsSection)
    .replace(/{conversation_signals_section}/g, conversationSignalsSection)
    .replace(/{decision_scaffolding_section}/g, decisionScaffoldingSection)
    .replace(/{meeting_state_section}/g, meetingStateSection)
    .replace(/{recent_transcript}/g, recentTranscript)

  if (!settings.liveSuggestionPrompt.includes('{meeting_prep_section}') && meetingPrepSection) {
    msg += `\n${meetingPrepSection}`
  }

  if (!settings.liveSuggestionPrompt.includes('{proof_points_section}') && proofPointsSection) {
    msg += `\n${proofPointsSection}`
  }

  if (!settings.liveSuggestionPrompt.includes('{decision_scaffolding_section}')) {
    msg += `\n\n${decisionScaffoldingSection}`
  }

  if (!settings.liveSuggestionPrompt.includes('{meeting_state_section}')) {
    msg += `\n\n${meetingStateSection}`
  }

  if (!settings.liveSuggestionPrompt.includes('{trigger_reason_section}') && triggerReasonSection) {
    msg += triggerReasonSection
  }

  if (!settings.liveSuggestionPrompt.includes('{conversation_signals_section}')) {
    msg += `\n\n${conversationSignalsSection}`
  }

  if (priorMeetingContext) {
    msg += '\n\n' + priorMeetingContext
  }

  return msg
}

async function fetchBatch(
  systemContent: string,
  userContent: string,
  apiKey: string,
  strict = false,
  previousSuggestions: Suggestion[] = [],
  blockedQuestionText?: string
): Promise<Suggestion[]> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  const promptText = `${systemContent}\n\n${strict ? STRICT_PREFIX + userContent : userContent}`

  const response = await withGroqTextBudget(promptText, SUGGESTION_MAX_TOKENS, 'high', () => groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: strict ? STRICT_PREFIX + userContent : userContent },
    ],
    temperature: 0.45,
    max_tokens: SUGGESTION_MAX_TOKENS,
  }))

  const raw = response.choices[0]?.message?.content ?? '[]'
  const cleanedRaw = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const arrayStart = cleanedRaw.indexOf('[')
  const arrayEnd = cleanedRaw.lastIndexOf(']')
  const jsonStr = arrayStart !== -1 && arrayEnd !== -1
    ? cleanedRaw.slice(arrayStart, arrayEnd + 1)
    : cleanedRaw

  const parsed = JSON.parse(jsonStr) as Array<{
    type: string
    title: string
    detail: string
    say?: string
    why_now?: string
    listen_for?: string
  }>

  const suggestions = parsed.slice(0, 7).map((item) => ({
    id: generateId(),
    type: normalizeType(item.type ?? ''),
    title: (item.title ?? '').trim(),
    detail: (item.detail ?? '').trim(),
    say: (item.say ?? '').trim() || undefined,
    whyNow: (item.why_now ?? '').trim() || undefined,
    listenFor: (item.listen_for ?? '').trim() || undefined,
  }))

  const cleanedSuggestions = sanitizeSuggestions(suggestions, previousSuggestions, blockedQuestionText)
  if (cleanedSuggestions.length < 2) {
    throw new Error('Suggestion batch was too weak to use')
  }

  return cleanedSuggestions
}

function tokenizeSemantic(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g) ?? []
}

function buildSemanticSet(suggestion: Pick<Suggestion, 'title' | 'detail'>): Set<string> {
  const tokens = tokenizeSemantic(`${suggestion.title} ${suggestion.detail}`)
    .filter((token) => !SEMANTIC_STOPWORDS.has(token))
  return new Set(tokens)
}

function semanticSimilarity(
  left: Pick<Suggestion, 'title' | 'detail'>,
  right: Pick<Suggestion, 'title' | 'detail'>
): number {
  const leftSet = buildSemanticSet(left)
  const rightSet = buildSemanticSet(right)
  if (leftSet.size === 0 || rightSet.size === 0) return 0

  let overlap = 0
  for (const token of Array.from(leftSet)) {
    if (rightSet.has(token)) overlap += 1
  }

  return overlap / Math.min(leftSet.size, rightSet.size)
}

function isSemanticDuplicate(
  candidate: Pick<Suggestion, 'title' | 'detail'>,
  existing: Array<Pick<Suggestion, 'title' | 'detail'>>
): boolean {
  return existing.some((item) => {
    const exactTitle = item.title.trim().toLowerCase() === candidate.title.trim().toLowerCase()
    const closeMeaning = semanticSimilarity(candidate, item) >= 0.72
    return exactTitle || closeMeaning
  })
}

function sanitizeSuggestions(
  suggestions: Suggestion[],
  previousSuggestions: Suggestion[] = [],
  blockedQuestionText?: string
): Suggestion[] {
  const seenTitles = new Set<string>()
  const cleaned: Suggestion[] = []
  const blockedQuestion = blockedQuestionText
    ? { title: blockedQuestionText, detail: blockedQuestionText }
    : null
  // Exact-title-only for cross-batch dedup: semantic at 0.72 blocks all same-domain angles
  // on narrow-topic meetings where the same keywords appear in every batch.
  const prevTitleKeys = new Set(previousSuggestions.map((s) => s.title.trim().toLowerCase()))

  for (const suggestion of suggestions) {
    const title = suggestion.title.replace(/\s+/g, ' ').trim()
    const detail = suggestion.detail.replace(/\s+/g, ' ').trim()
    const say = suggestion.say?.replace(/\s+/g, ' ').trim()
    if (!title || !detail) continue
    if (title.length < 6 || detail.length < 30) continue
    if (GENERIC_TITLE_PATTERN.test(title)) continue
    if (PLACEHOLDER_PATTERN.test(`${title} ${detail} ${say ?? ''}`)) continue

    const key = title.toLowerCase()
    if (seenTitles.has(key)) continue
    const candidate = { title, detail }
    if (suggestion.type === 'question' && blockedQuestion && semanticSimilarity(candidate, blockedQuestion) >= 0.68) continue
    if (isSemanticDuplicate(candidate, cleaned)) continue
    if (prevTitleKeys.has(key)) continue
    seenTitles.add(key)

    cleaned.push({
      ...suggestion,
      title,
      detail,
      say: say && !PLACEHOLDER_PATTERN.test(say) ? say : undefined,
    })
  }

  return cleaned
}

function scoreSuggestion(
  suggestion: Suggestion,
  recentChunks: TranscriptChunk[],
  meetingContext: MeetingContext,
  meetingState?: MeetingState
): number {
  let score = 0
  const latestText = recentChunks[recentChunks.length - 1]?.text.toLowerCase() ?? ''
  const combinedText = `${suggestion.title} ${suggestion.detail} ${suggestion.say ?? ''}`.toLowerCase()

  if (meetingState?.currentQuestion) {
    if (suggestion.type === 'answer') score += 4
    if (suggestion.type === 'talking_point') score += 2
    if (suggestion.type === 'question') score -= 3
  }

  if (meetingState?.questionIntent && meetingState.questionIntent !== 'meeting_coaching') {
    if (suggestion.type === 'answer') score += 2.25
    if (suggestion.type === 'talking_point') score += 1
    if (suggestion.type === 'question') score -= 2.5
  }

  if (meetingState?.riskyClaim && suggestion.type === 'fact_check') score += 3
  if (meetingState?.blocker && (suggestion.type === 'clarification' || suggestion.type === 'question')) score += 2
  if (meetingState?.deadlineSignal && suggestion.type === 'question') score += 1.5
  if (meetingState?.loopStatus && (suggestion.type === 'clarification' || suggestion.type === 'talking_point')) score += 2

  if (meetingState?.stakeholderSignals?.length) {
    const stakeholderMatches = meetingState.stakeholderSignals.filter((stakeholder) => combinedText.includes(stakeholder)).length
    score += Math.min(1.5, stakeholderMatches * 0.6)
  }

  if ((meetingState?.blocker || meetingState?.deadlineSignal) && OWNER_OR_TIMELINE_PATTERN.test(combinedText)) {
    score += 1.25
  }

  if (meetingState?.currentQuestion) {
    const questionTokens = meetingState.currentQuestion
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{2,}/g) ?? []
    const meaningfulTokens = questionTokens.filter((token) => !SEMANTIC_STOPWORDS.has(token)).slice(0, 4)
    const matchedTokens = meaningfulTokens.filter((token) => combinedText.includes(token)).length
    score += matchedTokens * 0.35
  }

  if (suggestion.say) score += 1.5
  if ((suggestion.say ?? suggestion.detail).length <= 180) score += 0.75
  if (meetingContext.goal && combinedText.includes(meetingContext.goal.toLowerCase().split(' ')[0] ?? '')) score += 0.5

  if (meetingState?.decisionFocus) {
    const focusToken = meetingState.decisionFocus.toLowerCase().split(' ')[0]
    if (focusToken && combinedText.includes(focusToken)) score += 0.75
  }

  if (latestText && combinedText.includes(latestText.split(' ')[0] ?? '')) score += 0.25

  return score
}

function rankSuggestions(
  candidates: Suggestion[],
  recentChunks: TranscriptChunk[],
  meetingContext: MeetingContext,
  meetingState?: MeetingState
): Suggestion[] {
  const scored = candidates
    .map((suggestion) => ({
      ...suggestion,
      score: scoreSuggestion(suggestion, recentChunks, meetingContext, meetingState),
    }))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))

  const chosen: Suggestion[] = []
  const usedTypes = new Set<string>()
  const knowledgeAnswerMode = meetingState?.questionIntent && meetingState.questionIntent !== 'meeting_coaching'

  for (const candidate of scored) {
    if (chosen.length >= 3) break
    if (chosen.length > 0 && isSemanticDuplicate(candidate, chosen)) continue

    if (knowledgeAnswerMode || !usedTypes.has(candidate.type) || chosen.length >= 2) {
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

export function buildFallbackSuggestions(
  recentChunks: TranscriptChunk[],
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' },
  meetingState?: MeetingState
): Suggestion[] {
  // Thin transcript: not enough signal to be specific
  if (recentChunks.length < 2) {
    return [
      { id: generateId(), type: 'question', title: 'Set the goal for this conversation', detail: 'Ask what outcome needs to happen before this meeting ends — a decision, a next step, or a specific question answered.', say: 'What outcome do we need to land on before this meeting ends?', whyNow: 'Too little transcript yet to give a specific suggestion.', listenFor: 'A concrete decision or deliverable, not just agreement to continue.' },
      { id: generateId(), type: 'question', title: 'Who makes the final call?', detail: 'Surface the decision-maker early. Knowing who can say yes — and what they need — saves time for everyone else.', say: 'Who is the final decision-maker here, and what do they need to see before they can say yes?', whyNow: 'Naming the decision-maker early prevents work that goes nowhere.', listenFor: 'A named person and a specific approval criterion.' },
      { id: generateId(), type: 'question', title: 'What does success look like?', detail: 'Anchor the conversation in a concrete outcome before it drifts. One shared definition of success keeps everyone aligned.', say: 'What would make this meeting a success — a decision made, a next step assigned, or a specific question answered?', whyNow: 'No clear outcome framed yet.', listenFor: 'A concrete deliverable instead of vague agreement.' },
    ]
  }

  const signals = extractConversationSignals(recentChunks)
  const latest = recentChunks[recentChunks.length - 1]
  const fallbacks: Suggestion[] = []
  const actionableQuestion = selectActionableQuestion(recentChunks, meetingContext)
  const currentQuestion = actionableQuestion?.text ?? meetingState?.currentQuestion ?? null
  const questionIntent = currentQuestion
    ? (meetingState?.questionIntent ?? inferQuestionIntent(currentQuestion, meetingContext))
    : null
  const questionCategory = currentQuestion ? inferQuestionCategory(currentQuestion) : null
  const primaryTopic = extractPrimaryTopic(recentChunks, `${currentQuestion ?? ''} ${meetingContext.goal ?? ''}`) ?? null

  if (currentQuestion && questionIntent && questionIntent !== 'meeting_coaching') {
    const topic = compactTopic(primaryTopic ?? currentQuestion)
    const axis = inferQuestionAxis(currentQuestion, questionCategory ?? 'general')
    const talkingPoint = buildAxisAwareTalkingPoint(topic, axis)
    const clarifier = buildAxisAwareQuestion(topic, axis)
    fallbacks.push(
      {
        id: generateId(),
        type: 'answer',
        title: `Answer the ${topic} question`,
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Answer the question itself first, then add the dependency, trade-off, or implication that would change the decision in this conversation.`,
        say: buildAxisAwareAnswer(topic, axis, questionCategory ?? 'general'),
        whyNow: 'A direct knowledge question is open, so the first card should answer it rather than coach around it.',
        listenFor: clarifier.listenFor,
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: talkingPoint.title,
        detail: talkingPoint.detail,
        say: talkingPoint.say,
        whyNow: 'A plain answer gets stronger when it includes the practical angle the room can act on.',
        listenFor: talkingPoint.listenFor,
      },
      {
        id: generateId(),
        type: 'question',
        title: clarifier.title,
        detail: clarifier.detail,
        say: clarifier.say,
        whyNow: 'One focused clarifier can make the answer more precise without derailing it.',
        listenFor: clarifier.listenFor,
      }
    )
  }

  if (signals.commitments[0]) {
    const c = signals.commitments[0]
    fallbacks.push({ id: generateId(), type: 'question', title: 'Lock the next step', detail: `A commitment surfaced: "${c.text}" [${c.timestamp}]. Confirm owner, deliverable, and timing before moving on.`, say: 'Before we wrap — who owns that exactly, and by when?', whyNow: 'Soft commitments evaporate without a named owner and a real date.', listenFor: 'A named owner and an actual date, not vague agreement.' })
  }

  if (signals.risks[0]) {
    const r = signals.risks[0]
    fallbacks.push({ id: generateId(), type: 'clarification', title: 'Resolve the open risk', detail: `Unresolved ambiguity: "${r.text}" [${r.timestamp}]. Define the owner or decision rule now before it creates downstream problems.`, say: 'Can we pin down the owner and timeline on this before moving on?', whyNow: 'Undefined risks become blockers after the meeting ends.', listenFor: 'A named owner and a concrete deadline.' })
  }

  if (signals.numericClaims[0]) {
    const n = signals.numericClaims[0]
    fallbacks.push({ id: generateId(), type: 'fact_check', title: 'Pressure-test the number', detail: `A number was stated: "${n.text}" [${n.timestamp}]. Ask for the source or assumption before the room plans around it.`, say: 'What assumption or source is that number based on?', whyNow: 'Unchallenged numbers become unexamined baselines.', listenFor: 'A real source or a sign the claim is softer than it sounds.' })
  }

  // Last resort: 3 universally useful cards
  if (fallbacks.length === 0) {
    fallbacks.push(
      { id: generateId(), type: 'talking_point', title: 'Anchor on the core point', detail: 'Summarize the most important thing in one sharp line and move the room toward a recommendation or decision.', say: 'The key point here is the concrete constraint or decision that should shape the next step.', whyNow: 'The conversation has signal but needs a sharper focus.', listenFor: 'Whether they want a recommendation, comparison, or decision.' },
      { id: generateId(), type: 'question', title: 'Ask for the use case', detail: 'The fastest path from overview to recommendation is to ask what outcome they are actually optimizing for.', say: 'Before I go broader, what use case or outcome are we optimizing for here?', whyNow: 'One concrete use case makes any answer twice as useful.', listenFor: 'A specific outcome or constraint rather than continued general exploration.' },
      { id: generateId(), type: 'clarification', title: 'Define the decision rule', detail: `Ask what would make this topic resolved before the conversation moves on${latest ? ` from [${latest.timestamp}]` : ''}.`, say: 'What would make this resolved today — a recommendation, a comparison, or a concrete next step?', whyNow: 'Without a decision rule, the room keeps circling.', listenFor: 'A concrete outcome instead of more broad explanation.' }
    )
  }

  return sanitizeSuggestions(fallbacks)
}

export async function generateSuggestionBatch(
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' },
  previousBatches: SuggestionBatch[] = [],
  priorMeetingContext?: string,
  options: SuggestionGenerationOptions = {}
): Promise<SuggestionBatch> {
  const windowSize = settings.suggestionContextWindow || 6
  const recentChunks = transcript.slice(-windowSize)
  const promptChunks = options.liveTranscriptPreview?.trim()
    ? [...recentChunks, { id: 'live-preview', text: options.liveTranscriptPreview.trim(), timestamp: 'LIVE' }]
    : recentChunks
  const previousSuggestions = previousBatches.flatMap((batch) => batch.suggestions)
  const latestQuestionText = selectActionableQuestion(promptChunks, meetingContext)?.text
  const systemPersona = buildSystemPersona(meetingContext.meetingType)
  const userContent = buildUserMessage(
    settings,
    recentChunks,
    meetingContext,
    previousBatches.slice(0, 2),
    priorMeetingContext,
    options
  )
  const transcriptSnapshot = promptChunks.map((c) => c.text).join(' ')

  let suggestions: Suggestion[] = []
  let groqFailed = false

  try {
    try {
      suggestions = await withRetry(
        () => fetchBatch(systemPersona, userContent, apiKey, false, previousSuggestions, latestQuestionText),
        2,
        500
      )
    } catch {
      suggestions = await withRetry(
        () => fetchBatch(systemPersona, userContent, apiKey, true, previousSuggestions, latestQuestionText),
        2,
        500
      )
    }
  } catch {
    groqFailed = true
    suggestions = []
  }

  suggestions = rankSuggestions(suggestions, promptChunks, meetingContext, options.meetingState)

  const fallbackSuggestions = buildFallbackSuggestions(promptChunks, meetingContext, options.meetingState)
  const previousTitleKeys = new Set(previousSuggestions.map((s) => s.title.trim().toLowerCase()))
  for (const fallback of fallbackSuggestions) {
    if (suggestions.length >= 3) break
    if (isSemanticDuplicate(fallback, suggestions)) continue
    // Only block exact-title repeats from previous batches — topic-aware fallbacks are
    // always better than the generic while-loop ones, even if topically similar.
    if (previousTitleKeys.has(fallback.title.trim().toLowerCase())) continue
    suggestions.push(fallback)
  }

  // Single last-resort pad — 2 real suggestions + 1 generic pad beats a broken contextual one.
  if (suggestions.length < 3) {
    const pad: Suggestion = {
      id: generateId(),
      type: 'question',
      title: 'Lock the next step',
      detail: 'Before the conversation moves on, confirm who owns the next action and by when — that is what turns discussion into momentum.',
      say: 'Before we move on — who owns the next step here, and by when should it be done?',
      whyNow: 'Every meeting needs to end with a named owner and a concrete date.',
      listenFor: 'A specific person and a real deadline, not vague agreement.',
    }
    if (!isSemanticDuplicate(pad, suggestions) && !previousTitleKeys.has(pad.title.trim().toLowerCase())) {
      suggestions.push(pad)
    }
  }

  return {
    id: generateId(),
    suggestions: suggestions.slice(0, 3),
    timestamp: formatTimestamp(new Date()),
    transcriptSnapshot: groqFailed
      ? `${transcriptSnapshot}\n[Local fallback suggestions used due to temporary Groq unavailability]`
      : transcriptSnapshot,
  }
}
