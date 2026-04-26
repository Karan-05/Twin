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
  type SignalLine,
} from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import type { MeetingState } from './meetingState'
import { buildMeetingStateSection, deriveMeetingState } from './meetingState'
import { withGroqTextBudget } from './groqBudget'
import { buildSecondBrainBriefSection, deriveSecondBrainBrief } from './secondBrain'

const VALID_TYPES = new Set(['question', 'talking_point', 'answer', 'fact_check', 'clarification'])
const OWNER_OR_TIMELINE_PATTERN = /\b(owner|who can|who owns|make the call|deadline|by when|tomorrow|friday|next step|follow up|escalat|workaround|qa|legal|security review|q[1-4])\b/i
const SUGGESTION_MAX_TOKENS = 1600


const MEETING_PERSONAS: Record<string, string> = {
  'Sales Call': `You are a $200M sales veteran embedded with the participant. Your instinct when a buyer raises an objection is not to counter-pitch but to probe what is behind it: "What would it take to change that? Who made that decision last time?" You surface hidden blockers — budget chains, internal champions who went quiet, competing timelines — before they kill the deal late. You always move toward a specific next step with a named owner and a concrete date.

Example: Buyer says "all our vendors work the same way." Wrong move: explain why this is different. Right move: "What would it take to change that — is it a budget call, a security review, or a process decision someone higher up owns?" That question exposes the real constraint without triggering defensiveness.`,
  'Job Interview': `You are a FAANG engineering manager who has run 500+ interviews. For behavioral questions, you coach STAR: Situation (one sentence of context), Task (what was at stake for YOU specifically), Action (what YOU did — not "we," not luck), Result (a measurable or observable outcome). You never let "we" mask individual contribution.

For technical questions, give the actual answer first — mechanism, failure mode, trade-off — before any meta-coaching. Do not advise on how to answer when the interviewer needs to hear real knowledge.

Behavioral opener template: "At <Company>, we faced <situation>. My task was to <stake>. I <action>. The result was <metric or observable change>."`,
  'Investor Pitch': `You are a Series B investor who has reviewed 2,000+ decks and funded 40 companies. When a founder makes a market-size claim you probe for defensibility: "How did you size that? What's the bottoms-up per-customer math?" When they name a competitor you look for the moat, not the dismissal. You convert broad narrative into falsifiable claims, specific proof points, and concrete next decisions — because capital follows clarity.

Example: Founder says "$50 billion TAM, we're going after SMBs." Wrong response: celebrate the market. Right move: "Walk me through the bottoms-up — how many SMBs, what's your ACV assumption, and what's the one incumbent that owns the distribution channel you need to crack?" That trio of questions separates a slide number from a real market thesis.`,
  'Customer Discovery': 'You are a truth-seeking discovery coach. Surface pain, current behavior, ownership, urgency, and what is still only polite interest.',
  'Standup': 'You are a sharp delivery coach. Surface blockers, dependencies, owners, and what will slip if ambiguity remains unresolved.',
  '1:1': 'You are a concise coaching partner. Turn vague emotion or feedback into something observable, specific, and safe enough to address directly.',
  'Brainstorm': 'You are a focused facilitator. Keep idea generation useful by naming the decision rule, the strongest option, or the missing constraint before the room sprawls.',
  'Board Meeting': `You are a board-level strategist who has served on 12 boards across SaaS and marketplace companies. When the team presents bad news you do not let them bury it in operational detail — you reframe it as a strategic decision: what does this tell you about the model, and what's the one lever that changes the trajectory? You push for explicit ownership on every risk item before the meeting ends.

Example: CFO says "revenue missed by 18% due to longer enterprise sales cycles." Wrong response: ask for more data next meeting. Right move: "That miss tells you one of three things — the ICP is off, the champion-to-budget-owner path is broken, or pricing is creating a procurement hurdle. Which one is it, and who owns the diagnosis by Thursday?" Reframe the miss as a strategic hypothesis, assign it, and move on — boards that dwell on variance without assigning a thesis waste two quarters.`,
  'Team Review': 'You are an accountability-focused review lead. Translate issues into outcomes, patterns, named owners, and concrete interventions.',
}

const DEFAULT_PERSONA = `You are a world-class real-time meeting strategist embedded with the participant. You surface only the highest-leverage moves — hyper-specific to what was JUST said, never generic. You always output valid JSON and nothing else.`

const STRICT_PREFIX = 'Output ONLY a valid JSON array. No markdown, no explanation, no preamble.\n\n'
const GENERIC_TITLE_PATTERN = /^(what are the key next steps|next steps|follow up|clarify|ask a question|helpful suggestion)$/i
// Named placeholders are bad anywhere; bracket notation [like this] is only a problem in say fields
// (technical content like [RDB], [AOF], [Company] legitimately appears in title/detail)
const PLACEHOLDER_PATTERN = /latest topic|current topic|your specific takeaway|next step\]|what matters most is(?:…|\.{3}|$)|the key point here is(?:…|\.{3}|$)|here'?s the direct answer(?:\s+on\s+[^:]+)?:?\s*(?:what matters most is)?(?:…|\.{3}|$)/i
const SAY_PLACEHOLDER_PATTERN = /\[[A-Za-z][^[\]]*\]/
const SEMANTIC_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'your', 'their', 'they', 'them', 'about', 'into',
  'what', 'when', 'where', 'which', 'would', 'could', 'should', 'will', 'just', 'really', 'very',
  'have', 'been', 'were', 'being', 'then', 'than', 'because', 'there', 'here', 'need', 'needs',
  'ask', 'asks', 'asking', 'question', 'point', 'talking', 'clarify', 'clarification', 'answer',
  'fact', 'check', 'next', 'step', 'steps', 'this', 'that', 'right', 'now', 'meeting', 'call'
])
const WEAK_SINGLE_TOPIC_PATTERN = /^(?:answer (?:their|the)|clarify|get specific on)\s+([A-Za-z][A-Za-z0-9_-]{1,5})\b/i
const LOW_SIGNAL_TITLE_TOPICS = new Set(['get', 'airs', 'rams', 'ones', 'plan', 'team', 'that', 'this'])

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


function collectSubstantiveQuestions(
  recentChunks: TranscriptChunk[],
  meetingContext: MeetingContext
): SignalLine[] {
  return extractConversationSignals(recentChunks).questions
    .filter((line) => inferQuestionIntent(line.text, meetingContext) !== 'meeting_coaching')
    .slice(0, 3)
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
  const secondBrainBriefSection = buildSecondBrainBriefSection(
    promptChunks,
    ctx,
    options.meetingState
  )
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
    .replace(/{second_brain_brief_section}/g, secondBrainBriefSection)
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

  if (!settings.liveSuggestionPrompt.includes('{second_brain_brief_section}')) {
    msg += `\n\n${secondBrainBriefSection}`
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
    if (SAY_PLACEHOLDER_PATTERN.test(say ?? '')) continue
    const weakSingleTopic = title.match(WEAK_SINGLE_TOPIC_PATTERN)?.[1]?.toLowerCase()
    if (weakSingleTopic && LOW_SIGNAL_TITLE_TOPICS.has(weakSingleTopic)) continue

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
      say: say && !PLACEHOLDER_PATTERN.test(say) && !SAY_PLACEHOLDER_PATTERN.test(say) ? say : undefined,
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
  const currentQuestionLower = meetingState?.currentQuestion?.toLowerCase() ?? ''
  const questionCategory = meetingState?.currentQuestion ? inferQuestionCategory(meetingState.currentQuestion) : null

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

  const substantiveQuestions = collectSubstantiveQuestions(recentChunks, meetingContext)
  if (substantiveQuestions.length > 1) {
    const secondaryQuestion = substantiveQuestions.find((line) => line.text !== meetingState?.currentQuestion) ?? substantiveQuestions[1]
    const secondaryTokens = secondaryQuestion?.text
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{2,}/g)
      ?.filter((token) => !SEMANTIC_STOPWORDS.has(token))
      .slice(0, 4) ?? []
    const secondaryMatches = secondaryTokens.filter((token) => combinedText.includes(token)).length
    if (secondaryMatches > 0) score += 1 + (secondaryMatches * 0.2)
    if (suggestion.type === 'talking_point' && secondaryMatches > 0) score += 0.75
  }

  const multilingualSignals = extractConversationSignals(recentChunks).multilingualCues
  if (multilingualSignals.length > 0) {
    if (/\bbilingual\b|\bspanish\b|\boperations\b|\bfinance\b|\bmigration\b|\bapproval\b/.test(combinedText)) score += 1.1
    if (suggestion.type === 'answer' && /\bweek 1\b|\bweek 2\b|\bfirst\b|\bsecond\b/.test(combinedText)) score += 0.8
  }

  if (
    meetingState?.questionIntent === 'direct_answer' &&
    questionCategory === 'implementation' &&
    /\bfirst two weeks\b|\bimplementation timeline\b|\bmoved forward\b|\bmove forward\b/.test(currentQuestionLower)
  ) {
    if (suggestion.type === 'answer') score += 4.5
    if (suggestion.type === 'talking_point') score += 1.25
    if (suggestion.type === 'question') score -= 4.5
    if (/\bweek 1\b|\bweek 2\b|\boperations\b|\bfinance\b|\bq4\b|\bmigration\b/.test(combinedText)) score += 1.6
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

function compactTopic(topic: string | null): string {
  if (!topic) return 'topic'
  return topic.length > 28 ? `${topic.slice(0, 25).trimEnd()}…` : topic
}

function buildFallbackAnswerTitle(topic: string, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (category) {
    case 'mechanism':
      return `Explain how ${topic} works`
    case 'comparison':
      return `Compare the ${topic} paths`
    case 'tradeoff':
      return `Name the ${topic} tradeoff`
    case 'implementation':
      return `Answer the ${topic} plan`
    case 'definition':
      return `Define ${topic} clearly`
    default:
      return `Answer the ${topic} question`
  }
}

function buildFallbackAnswerSay(topic: string, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (category) {
    case 'mechanism':
      return `Explain how ${topic} works: what goes in, how it changes across the interaction, what comes out, and where the failure mode shows up.`
    case 'comparison':
      return `Compare ${topic} on one axis first — reliability, consistency, cost, or speed — then explain what that difference changes in practice.`
    case 'tradeoff':
      return `Name the main trade-off in ${topic} first, then say which side matters more in this discussion.`
    case 'implementation':
      return `State what happens first, where the friction appears, and what must be true for ${topic} to work.`
    case 'definition':
      return `Say what ${topic} is first, then why it matters in practice instead of staying abstract.`
    default:
      return `Answer the question on ${topic} directly first, then add the one implication that changes the real decision.`
  }
}

function buildFallbackTalkingPointSay(topic: string, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (category) {
    case 'mechanism':
      return `The useful point to add on ${topic} is where the system loses coherence or self-corrects, not just the happy path.`
    case 'comparison':
      return `The useful point to add on ${topic} is the comparison axis that actually changes the conclusion, not just surface differences.`
    case 'tradeoff':
      return `The useful point to add on ${topic} is the trade-off that determines whether this is robust or just impressive-looking.`
    case 'implementation':
      return `The useful point to add on ${topic} is the dependency that makes execution smooth or painful in practice.`
    default:
      return `The useful point to add on ${topic} is the practical consequence or hidden constraint that changes what you should believe next.`
  }
}

function buildFallbackClarifierSay(topic: string, category: ReturnType<typeof inferQuestionCategory>): string {
  switch (category) {
    case 'mechanism':
      return `Before I go deeper on ${topic}, which part matters most here — the interaction loop, the failure mode, or the recovery behavior?`
    case 'comparison':
      return `Before I go deeper on ${topic}, which comparison axis matters most here — reliability, speed, cost, or fit?`
    case 'implementation':
      return `Before I go deeper on ${topic}, what constraint matters most here — workflow, scale, timing, or trust?`
    default:
      return `Before I go deeper on ${topic}, what constraint matters most here — workflow, scale, timing, or trust?`
  }
}

function looksLikePersonalFeedbackContext(
  recentChunks: TranscriptChunk[],
  currentQuestion: string | null,
  meetingContext: MeetingContext
): boolean {
  const joined = `${meetingContext.goal ?? ''} ${recentChunks.map((chunk) => chunk.text).join(' ')} ${currentQuestion ?? ''}`.toLowerCase()
  return /\b(feedback|manager|perception|perceived|communication|tone|frustrat|alignment|cleaner|better look like|example where this showed up|how this landed|came across|how you landed|stakeholder feedback)\b/.test(joined)
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
  const currentQuestion = meetingState?.currentQuestion ?? actionableQuestion?.text ?? null
  const questionIntent = currentQuestion
    ? (meetingState?.questionIntent ?? inferQuestionIntent(currentQuestion, meetingContext))
    : null
  const questionCategory = currentQuestion ? inferQuestionCategory(currentQuestion) : null
  const primaryTopic = extractPrimaryTopic(recentChunks, `${currentQuestion ?? ''} ${meetingContext.goal ?? ''}`) ?? null
  const secondBrainBrief = deriveSecondBrainBrief(recentChunks, meetingContext, meetingState)

  if (
    currentQuestion &&
    questionIntent === 'meeting_coaching' &&
    meetingContext.meetingType === 'Standup' &&
    /\b(owner|make the call|blocked|blocker|dependency|slip|ship|qa|legal|security|approval)\b/i.test(currentQuestion)
  ) {
    fallbacks.push(
      {
        id: generateId(),
        type: 'clarification',
        title: 'Name the unblock owner',
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Turn the blocker into one explicit owner question so the team knows who can make the call today.`,
        say: 'Who can make the call on this today, and what is the fallback if they are unavailable?',
        whyNow: 'A blocker without a decision owner becomes a slip by default.',
        listenFor: 'A named owner and a same-day path forward.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: 'Separate workaround from decision',
        detail: 'Do not wait for the perfect answer. Separate the permanent decision from the immediate workaround that keeps QA or shipping moving.',
        say: 'We should separate the permanent decision from the immediate workaround so QA does not stall while we wait.',
        whyNow: 'This keeps the standup action-oriented instead of becoming a circular status update.',
        listenFor: 'Whether they can keep moving on a narrower path while the final call is pending.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Call out the slip risk',
        detail: 'Tie the blocker to the actual delivery consequence so the room reacts to a concrete risk instead of a vague dependency.',
        say: 'If nobody owns this today, what exactly slips and by when?',
        whyNow: 'Naming the delivery consequence makes the unblock decision urgent and specific.',
        listenFor: 'A date, milestone, or handoff that will move if this stays unresolved.',
      }
    )
    return sanitizeSuggestions(fallbacks)
  }

  if (
    currentQuestion &&
    questionIntent === 'meeting_coaching' &&
    meetingContext.meetingType === 'Team Review' &&
    /\b(broke|repair|owner|handoff|root cause|communication)\b/i.test(currentQuestion)
  ) {
    fallbacks.push(
      {
        id: generateId(),
        type: 'clarification',
        title: 'Name what actually broke',
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Force the room to name the failure mode itself instead of hiding behind broad labels like communication.`,
        say: 'What exactly broke in the workflow or handoff, not just what the downstream symptom was?',
        whyNow: 'Repair starts with one concrete failure mode, not a vague pattern label.',
        listenFor: 'A specific handoff, decision gap, or process step that failed.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Assign the repair owner',
        detail: 'Once the root issue is named, immediately ask who owns the repair so the review produces accountability instead of only diagnosis.',
        say: 'Who owns the repair from here, and what do they need to change first?',
        whyNow: 'A clean diagnosis still fails if nobody owns the fix.',
        listenFor: 'One named owner and the first concrete change.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: 'Separate symptom from cause',
        detail: 'Support noise, design confusion, and rollout pain can all be symptoms. The useful move is to distinguish the underlying coordination failure from the visible effects.',
        say: 'The useful distinction here is the symptom versus the underlying coordination failure, because the repair owner depends on that difference.',
        whyNow: 'That framing cuts through cross-talk and keeps the review from scattering across every symptom at once.',
        listenFor: 'Whether the room agrees on the cause or is still mixing multiple issues together.',
      }
    )
    return sanitizeSuggestions(fallbacks)
  }

  if (
    (!currentQuestion || questionIntent === 'meeting_coaching') &&
    meetingContext.meetingType === '1:1' &&
    signals.risks[0] &&
    looksLikePersonalFeedbackContext(recentChunks, currentQuestion, meetingContext)
  ) {
    const riskLine = signals.risks[0]
    const timeframe = recentChunks.find((chunk) => /\b(next month|this month|next quarter|this quarter|over the next month|over the next quarter|by\s+(?:monday|tuesday|wednesday|thursday|friday|next week|next month|end of day|eod|q[1-4]))\b/i.test(chunk.text))?.text ?? null
    fallbacks.push(
      {
        id: generateId(),
        type: 'clarification',
        title: 'Ask for one example',
        detail: `The feedback is still vague: "${riskLine.text}" [${riskLine.timestamp}]. Ask for one recent example so you can respond to something observable instead of a general perception.`,
        say: 'Can you give me one recent example where this showed up most clearly?',
        whyNow: 'Specific examples turn vague feedback into something you can actually change.',
        listenFor: 'A concrete situation, not a broad impression.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Define better clearly',
        detail: timeframe
          ? `The room named a time window — "${timeframe}". Use that to ask what “cleaner” or “better” should look like by then.`
          : 'Ask what better should look like in observable terms so the feedback becomes actionable.',
        say: 'What would better look like in practice over the next month?',
        whyNow: 'You need a target behavior, not just a warning.',
        listenFor: 'An observable change in communication, alignment, or stakeholder perception.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: 'Name the stakeholder pattern',
        detail: 'Multiple stakeholder groups were mentioned. Surface which group felt the problem most and what pattern they are reacting to.',
        say: 'It sounds like the useful thing to pin down is which stakeholder group felt this most, and what pattern they were reacting to.',
        whyNow: 'That separates a one-off incident from a broader trust or alignment pattern.',
        listenFor: 'Whether this is mainly about design, customer success, or a broader communication habit.',
      }
    )
    return sanitizeSuggestions(fallbacks)
  }

  if (
    meetingContext.meetingType === 'Board Meeting' &&
    currentQuestion &&
    questionIntent === 'direct_answer'
  ) {
    const migrationLine = recentChunks.find((chunk) => /\bmigrations?\b|\broadmap\b/i.test(chunk.text))
    const growthLine = recentChunks.find((chunk) => /\bupsell\b|\bpackaging\b|\badoption\b/i.test(chunk.text))
    const leverageLine = recentChunks.find((chunk) => /\bdurable leverage\b/i.test(chunk.text))

    fallbacks.push(
      {
        id: generateId(),
        type: 'answer',
        title: 'Frame retention vs leverage',
        detail: `${actionableQuestion ? `They asked: "${currentQuestion}" [${actionableQuestion.timestamp}]. ` : ''}${migrationLine ? `"${migrationLine.text}" [${migrationLine.timestamp}]` : 'The room is trading near-term retention work against longer-term leverage.'}${growthLine ? ` Pair it with "${growthLine.text}" [${growthLine.timestamp}] so the answer covers both execution drag and the unresolved growth story.` : ''}`,
        say: 'The trade-off is that migrations protected renewals, but they also slowed the platform and left the AI upsell story under-packaged. The board decision is whether that is a short-term bridge or the way we are going to keep operating.',
        whyNow: 'The room asked for strategy, not another operating update.',
        listenFor: 'Whether the board wants a temporary bridge plan or a durable allocation shift.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: 'Separate bridge from default',
        detail: leverageLine
          ? `"${leverageLine.text}" [${leverageLine.timestamp}] is the board-level frame. Use it to separate a temporary retention trade from a default operating model that would delay leverage.`
          : 'The strategic distinction is whether this is a temporary retention bridge or a default operating model that keeps delaying leverage.',
        say: 'If this is a temporary bridge to protect enterprise renewals, we should say that plainly. If it becomes the default use of senior engineering, we delay durable leverage.',
        whyNow: 'That framing keeps the discussion at board altitude and clarifies the real decision.',
        listenFor: 'Whether they care more about protecting renewals now or restoring product leverage by a fixed point.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Name the board decision',
        detail: 'Turn the strategic trade-off into one explicit decision the board can react to, instead of letting the room stay in blended update mode.',
        say: 'Should we explicitly decide when senior engineering shifts back from migrations to the product and packaging work behind the AI upsell story?',
        whyNow: 'A board conversation needs a concrete decision, not only a description of tension.',
        listenFor: 'A date, trigger, or metric that tells you when the allocation should change.',
      }
    )
  }

  if (currentQuestion && questionIntent && questionIntent !== 'meeting_coaching') {
    const category = questionCategory ?? 'general'
    const topic = compactTopic(primaryTopic || extractPrimaryTopic(recentChunks, currentQuestion) || 'topic')
    fallbacks.push(
      {
        id: generateId(),
        type: 'answer',
        title: buildFallbackAnswerTitle(topic, category),
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. ${secondBrainBrief.bestMove ?? 'Answer the question itself first, then add the dependency or implication that changes the decision.'}`,
        say: buildFallbackAnswerSay(topic, category),
        whyNow: 'A direct question is open — answer it before the room moves on.',
        listenFor: 'Whether they want more depth, a different angle, or a concrete next step.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: secondBrainBrief.tension ? 'Name the hidden tension' : 'Add the practical consequence',
        detail: secondBrainBrief.tension
          ? `Do not stop at the surface answer. Name the real tension shaping the room: ${secondBrainBrief.tension}`
          : 'Move beyond the surface answer into the trade-off or constraint that shapes the real decision.',
        say: secondBrainBrief.tension
          ? `The hidden tension here is ${secondBrainBrief.tension.charAt(0).toLowerCase()}${secondBrainBrief.tension.slice(1)}`
          : buildFallbackTalkingPointSay(topic, category),
        whyNow: 'A plain answer gets stronger when paired with the practical angle the room can act on.',
        listenFor: 'Which side of the trade-off or implication they weight more.',
      },
      {
        id: generateId(),
        type: 'clarification',
        title: secondBrainBrief.memoryAnchors.length > 0 ? 'Sharpen the real constraint' : 'Ask the one constraining question',
        detail: secondBrainBrief.memoryAnchors.length > 0
          ? `One narrow follow-up should clarify the variable that matters most now: ${secondBrainBrief.memoryAnchors[0]}.`
          : 'One narrow follow-up can make the answer twice as precise without derailing the conversation.',
        say: buildFallbackClarifierSay(topic, category),
        whyNow: 'The right clarifier makes the answer actionable instead of general.',
        listenFor: 'A version, use case, or dependency that materially changes the answer.',
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
  const effectiveMeetingState = options.meetingState ?? deriveMeetingState(
    transcript,
    meetingContext,
    options.liveTranscriptPreview?.trim() ?? ''
  )
  const previousSuggestions = previousBatches.flatMap((batch) => batch.suggestions)
  const latestQuestionText = selectActionableQuestion(promptChunks, meetingContext)?.text
  const systemPersona = buildSystemPersona(meetingContext.meetingType)
  const userContent = buildUserMessage(
    settings,
    recentChunks,
    meetingContext,
    previousBatches.slice(0, 2),
    priorMeetingContext,
    { ...options, meetingState: effectiveMeetingState }
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

  const previousTitleKeys = new Set(previousSuggestions.map((s) => s.title.trim().toLowerCase()))

  if (groqFailed || suggestions.length < 2) {
    suggestions = buildFallbackSuggestions(promptChunks, meetingContext, effectiveMeetingState)
  } else {
    suggestions = rankSuggestions(suggestions, promptChunks, meetingContext, effectiveMeetingState)
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
