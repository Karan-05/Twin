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


// Meeting-type-specific personas with a single inline few-shot example showing the quality bar
const MEETING_PERSONAS: Record<string, string> = {
  'Sales Call': `You are a veteran enterprise sales strategist who has closed $200M+ in deals. You instantly read buying signals, hidden objections, and champion/blocker dynamics. You know the exact right question at the exact right moment is worth more than any pitch deck.

Quality example:
[JUST SAID] "We've looked at a few solutions and they're all pretty similar honestly."
→ [{"type":"fact_check","title":"'All similar' masks the real objection","detail":"This is a stall or a signal they're not the decision maker. Push gently: 'What would make one clearly stand out for you?' A great answer names the real criterion. A vague answer means the champion hasn't built internal buy-in — you need to escalate."},{"type":"question","title":"Map the full buying committee now","detail":"'All similar' often means consensus isn't built. Ask: 'Who else will weigh in on this before a decision?' Naming ops, finance, or legal early lets you shape the evaluation rather than react to it later."},{"type":"talking_point","title":"Anchor your differentiator then lock a next step","detail":"Counter the commoditization frame with your sharpest point tied to THEIR stated concern — then advance: 'If I can show you specifically how we handle [their stated concern], would it make sense to get your ops lead on a 30-minute call this week?'"}]`,

  'Job Interview': `You are a former FAANG hiring manager who has run 600+ interviews across engineering, product, and leadership. You know the signals that separate top-1% talent from good candidates. You help the participant give sharp, specific answers — for technical questions you supply the answer FRAMEWORK and key components they should cover; for behavioral questions you supply the STAR arc they should use.

Quality example — BEHAVIORAL question:
[00:01:27] "Can you tell me about a time you had to make a decision with incomplete information?"
[JUST SAID] "Also, are you comfortable working across product, engineering, and support when things get busy?"
→ [{"type":"answer","title":"Answer the incomplete-information question first","detail":"The first question is the higher-signal behavioral ask. Lead with: 'We had three days to launch and the usage data was split — I polled two stakeholders, picked the option we could walk back, and shipped. [Your real outcome].' Three sentences: situation, the gap, how you decided anyway. The interviewer is listening for agency and a decision heuristic, not caution.","say":"We had [your situation] — I polled two stakeholders, picked the option we could walk back, and shipped. Here's what happened: [your real outcome]."},{"type":"answer","title":"Confirm cross-functional comfort with a story","detail":"Don't just say yes — demonstrate it: 'Yes — in my last role I ran the weekly incident call with eng, support, and PM during [your real crunch]. My job was to translate priorities, not just relay them.' One concrete cross-functional moment beats any claim about being a team player.","say":"Yes — at [your company] I ran the weekly sync across eng, support, and PM during [crunch period]. My job was translating priorities, not just relaying them."},{"type":"question","title":"Ask how decisions get made under shifting priorities","detail":"After answering, probe: 'What's the team's default when you're 60% confident but the deadline is today?' A great answer reveals the operating model. A vague answer signals decision norms aren't discussable — a red flag on a fast-moving team.","say":"Quick question for me — what's the team's default when you're 60% confident but the deadline is today?"}]

For TECHNICAL questions (any domain — systems, algorithms, architecture, language-specific, etc.):
→ suggestion #1 must be type="answer" — lead with the key components or steps to cover, then a verbatim speakable opener line the candidate can use immediately. Do NOT say "great question". Start with the answer structure.
→ suggestion #2 can be a talking_point that proactively addresses a likely follow-up (e.g. tradeoff, failure mode, production gotcha).
→ suggestion #3 should be type="question" — a clarifying question the candidate can ask back to show systems-design thinking (e.g. scale, constraints, tradeoffs, latency targets).
Apply this pattern to whatever technical topic was actually asked — Kafka, Redis, load balancing, consistent hashing, ML pipelines, OpenCV, language runtimes, anything. Never hardcode a specific domain in the persona.`,

  'Investor Pitch': `You are a General Partner at a Tier-1 VC who has evaluated 3,000+ pitches and led 40 investments. You spot instantly whether founders truly understand their market, unit economics, and path to defensibility.

Quality example:
[JUST SAID] "Our TAM is $50 billion."
→ [{"type":"fact_check","title":"$50B TAM — pre-empt the bottom-up challenge","detail":"Any serious investor will push on this. If you haven't: 'We built this bottom-up: [X customers] × [$Y ACV] = $Z reachable.' Top-down TAM framing signals shallow market analysis and kills conviction fast."},{"type":"talking_point","title":"State your beachhead before they ask","detail":"Large TAM claims invite 'so where do you actually start?' Get ahead of it: name the specific segment you dominate first, why you win there structurally, and why that wedge expands into the larger market."},{"type":"question","title":"Ask what thesis they've seen win here","detail":"'What have you seen work in this space?' reveals their prior bets and mental model. Essential context for pitching to THIS partner — it tells you which proof points matter most to them."}]`,

  'Customer Discovery': `You are a Y Combinator partner who has run 1,000+ customer discovery interviews. You know how to separate genuine pain from politeness, avoid leading questions, and find the insight that pivots a company.

Quality example:
[JUST SAID] "Yeah it would be nice to have something like that."
→ [{"type":"fact_check","title":"'Nice to have' is NOT a pain signal","detail":"This is the most dangerous phrase in discovery — it sounds positive but signals low priority. Follow immediately: 'How are you solving this today?' If they have a clunky workaround, there's real pain. If they say 'we're not,' it's a vitamin not a painkiller."},{"type":"question","title":"Ask how much time they lose to this weekly","detail":"Quantify the pain: 'How many hours a week does this cost your team?' Numbers force specificity. If they can't answer, the problem isn't real enough to buy a solution. If they say 4+ hours, you have a lead."},{"type":"clarification","title":"Is this their problem or their boss's?","detail":"Discover who actually owns this pain. Ask: 'Is this something you personally feel, or more of a team/leadership concern?' The answer tells you your champion, buyer, and whether this deal can close bottom-up."}]`,

  'Standup': `You are a staff engineer who leads high-performing teams. You keep standups sharp: surface blockers fast, prevent status updates from consuming decision time, and ensure the right technical calls happen in dedicated sessions — not in standup.`,

  '1:1': `You are an executive coach with 20 years of experience developing leaders. You help surface what's not being said, build real trust, and turn 1:1s from status checks into genuine career and performance conversations.`,

  'Brainstorm': `You are a world-class product strategist and facilitator. You prevent brainstorms from converging too early, ensure quiet voices get heard, and push teams past their first-obvious ideas toward genuine insight.`,

  'Board Meeting': `You are a seasoned independent board director with experience at public and pre-IPO companies. You focus on the metrics that matter, surface governance and strategic risks early, and keep boards aligned on strategy — not drifting into operations.

Quality example:
[00:00:12] "Revenue landed eight percent below plan, but enterprise renewals were stronger than expected."
[00:01:29] "How should we think about the tradeoff between near-term retention work and the longer-term product story?"
[JUST SAID] "I'm less worried about this quarter than whether we're building a company with durable leverage."
→ [{"type":"answer","title":"Reframe the 8% miss as a deliberate bet","detail":"Respond directly: 'The eight-percent gap [00:00:12] is the cost of a conscious trade — retention over roadmap velocity. The question for this board is whether that bet buys enough renewal momentum to re-accelerate in H2, and what metric tells us by when.' This reframes the miss as a tradeoff, not a drift, and names what must be tracked."},{"type":"clarification","title":"Define 'durable leverage' before the AI decision","detail":"'Durable leverage' means different things: platform moat, switching costs, or contract structure. Ask: 'When you say durable — which of those do we need to validate before committing the AI packaging timeline?' Without that definition, the board can't evaluate the second-half plan."},{"type":"question","title":"Who owns the AI packaging decision?","detail":"The packaging isn't settled [00:01:01] and it's the stated H2 growth lever. Ask: 'Who has the authority to finalize it, and what is the one open question blocking that call?' If nobody can answer, assign an owner and a date before this meeting ends."}]`,

  'Team Review': `You are a director of engineering who runs quarterly reviews that drive real accountability. You focus on outcomes over effort, surface systemic patterns behind missed targets, and ensure every action item has a named owner and a date.`,
}

const DEFAULT_PERSONA = `You are a world-class real-time meeting strategist embedded with the participant. You surface only the highest-leverage moves — hyper-specific to what was JUST said, never generic. You always output valid JSON and nothing else.`

const STRICT_PREFIX = 'Output ONLY a valid JSON array. No markdown, no explanation, no preamble.\n\n'
const GENERIC_TITLE_PATTERN = /^(what are the key next steps|next steps|follow up|clarify|ask a question|helpful suggestion)$/i
const PLACEHOLDER_PATTERN = /\[[A-Za-z][^[\]]*\]|latest topic|current topic|your specific takeaway|next step\]|what matters most is(?:…|\.{3}|$)|the key point here is(?:…|\.{3}|$)|here'?s the direct answer(?:\s+on\s+[^:]+)?:?\s*(?:what matters most is)?(?:…|\.{3}|$)/i
const SELLERISH_ROLE_PATTERN = /\b(seller|account executive|sales manager)\b/i
const DELIVERY_PATTERN = /\b(deliver|delivery|ship|shipping|arrival|arrive|lead time|timeline|when can)\b/i
const QUANTITY_PATTERN = /\b(how many|quantity|quantities|units?|seats?|licenses?|order about|order size)\b/i
const CUSTOMIZATION_PATTERN = /\b(customi[sz]|configuration|software|boot time|image|engrave|engraved|color|colour|space gray|space grey)\b/i
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

function isSellerishSalesContext(ctx: MeetingContext): boolean {
  return ctx.meetingType === 'Sales Call' && SELLERISH_ROLE_PATTERN.test(ctx.userRole || '')
}

function compactTopic(topic?: string | null): string {
  if (!topic) return 'this topic'
  return topic.length > 28 ? `${topic.slice(0, 25).trimEnd()}…` : topic
}

function inferSalesQuestionKind(questionText: string): 'delivery' | 'quantity' | 'customization' | 'general' {
  if (DELIVERY_PATTERN.test(questionText)) return 'delivery'
  if (QUANTITY_PATTERN.test(questionText)) return 'quantity'
  if (CUSTOMIZATION_PATTERN.test(questionText)) return 'customization'
  return 'general'
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

  if (meetingContext.meetingType === 'Investor Pitch') {
    if (/(wedge|beachhead|security review|upmarket|arr|month over month|mom)/i.test(combinedText)) score += 1
    if (/(incumbent|bundle|defensibility|why now)/i.test(combinedText)) score += 0.9
  }

  if (meetingContext.meetingType === 'Sales Call') {
    if (/(first two weeks|implementation|timeline|q4|finance|operations|ops|approval)/i.test(combinedText)) score += 1
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

  if (currentQuestion && questionIntent === 'product_knowledge' && isSellerishSalesContext(meetingContext)) {
    const questionKind = inferSalesQuestionKind(currentQuestion)

    if (questionKind === 'delivery') {
      fallbacks.push(
        {
          id: generateId(),
          type: 'answer',
          title: 'Answer the delivery timing',
          detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Answer with the delivery window, what it depends on (stock or configuration), and the next step to confirm the order.`,
          say: 'The clean answer is the delivery window, any dependency on stock or configuration, and what we need to confirm today to lock the order.',
          whyNow: 'The buyer moved from exploration into a concrete purchasing question.',
          listenFor: 'Whether standard stock works, or whether configuration choices will change timing.',
        },
        {
          id: generateId(),
          type: 'clarification',
          title: 'Confirm the order details',
          detail: 'Before promising timing, pin down the exact quantity, standard versus custom units, and any non-default requirements that could change fulfillment.',
          say: 'Before I commit to timing, let me confirm quantity, standard versus custom units, and whether you need any non-default setup.',
          whyNow: 'Delivery answers are only credible if the fulfillment assumptions are explicit.',
          listenFor: 'Anything custom that changes lead time or fulfillment complexity.',
        },
        {
          id: generateId(),
          type: 'talking_point',
          title: 'Separate stock from customization',
          detail: 'Frame the decision clearly: standard units can move faster, while custom images, software, engraving, or special configurations can add coordination.',
          say: 'The main trade-off here is simple: standard units move faster, while custom setup can change the delivery plan.',
          whyNow: 'That keeps the answer honest without sounding evasive.',
          listenFor: 'Whether speed matters more than custom setup for this order.',
        }
      )
      return sanitizeSuggestions(fallbacks)
    }

    if (questionKind === 'quantity') {
      fallbacks.push(
        {
          id: generateId(),
          type: 'answer',
          title: 'Confirm the order size',
          detail: `They asked or answered a quantity question: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Turn it into a concrete order-sizing answer: quantity, any configuration split, and what that means for next steps.`,
          say: 'The next answer should confirm the order size, whether every unit needs the same configuration, and what we need to finalize the purchase.',
          whyNow: 'The conversation is moving into real order planning, not general product positioning.',
          listenFor: 'Whether all units are identical or whether different teams need different specs.',
        },
        {
          id: generateId(),
          type: 'question',
          title: 'Check for config splits',
          detail: 'Ask whether the whole team needs the same setup or whether power users need a different configuration. That changes both pricing and fulfillment.',
          say: 'Will all units have the same setup, or do you expect a split between standard users and heavier workloads?',
          whyNow: 'A single sizing answer can hide a real configuration split.',
          listenFor: 'Whether one SKU works or the order needs segmentation.',
        },
        {
          id: generateId(),
          type: 'talking_point',
          title: 'Tie quantity to workflow fit',
          detail: 'Anchor the order size back to actual usage patterns instead of broad enthusiasm. That keeps the order credible and helps right-size the recommendation.',
          say: 'The useful way to size this is by matching the device configuration to the actual workload mix across the team.',
          whyNow: 'Quantity without workload fit can lead to overbuying or under-speccing.',
          listenFor: 'Whether local LLM and GPU-heavy work applies to everyone or only a subset.',
        }
      )
      return sanitizeSuggestions(fallbacks)
    }

    if (questionKind === 'customization') {
      fallbacks.push(
        {
          id: generateId(),
          type: 'answer',
          title: 'Lock the customizations',
          detail: `They asked about setup details: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Answer by separating standard order details from optional custom image, software, engraving, or color choices.`,
          say: 'The clean answer is whether you want a standard order or any custom setup such as software image, engraving, or non-default configuration before we finalize the order.',
          whyNow: 'Customization changes both fulfillment and delivery expectations.',
          listenFor: 'Any requirement beyond a standard order that needs to be captured now.',
        },
        {
          id: generateId(),
          type: 'question',
          title: 'Confirm standard vs custom',
          detail: 'Ask whether they want a standard company order or any special setup. That prevents vague “maybe later” custom requirements from surfacing after the quote.',
          say: 'Should I treat this as a standard order, or do you need any custom image, software, engraving, or color choice captured now?',
          whyNow: 'That single split determines whether this stays simple or needs extra coordination.',
          listenFor: 'Whether the order can stay standard and move fast.',
        },
        {
          id: generateId(),
          type: 'talking_point',
          title: 'Keep standard orders simple',
          detail: 'If they do not need custom setup, say that clearly and move the conversation toward confirmation and delivery rather than reopening broad discovery.',
          say: 'If this is a standard order, the fastest path is to confirm quantity, configuration, and delivery expectations now.',
          whyNow: 'The buyer is already close to operational decisions.',
          listenFor: 'A clean “standard order” answer you can convert into next steps.',
        }
      )
      return sanitizeSuggestions(fallbacks)
    }

    fallbacks.push(
      {
        id: generateId(),
        type: 'answer',
        title: `Define ${compactTopic(primaryTopic)} clearly`,
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Answer with the job this product serves, the team or workflow it fits, and the trade-off that matters most in practice.`,
        say: `The cleanest answer on ${compactTopic(primaryTopic)} is the job it does, who it is for, and the trade-off that matters in actual use.`,
        whyNow: 'This is a direct product question, so the answer should define the product in practical terms first.',
        listenFor: 'Which workflow, team, or buying constraint matters most for them.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Pick the buying constraint',
        detail: 'Move from broad product language to the real purchase criterion: performance, cost, speed to deploy, or customization.',
        say: 'Which matters most here — performance, standardization, speed to deploy, or customization?',
        whyNow: 'One buying constraint makes the answer more useful than a general product pitch.',
        listenFor: 'The criterion that should shape the rest of the recommendation.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: 'Tie the product to usage',
        detail: 'Frame the answer around workload fit, team usage, and operational trade-offs instead of broad enthusiasm.',
        say: 'The useful way to evaluate this product is the workload fit, the users it serves, and the operational trade-off it creates.',
        whyNow: 'That keeps the answer concrete and buyer-relevant.',
        listenFor: 'Whether they care most about performance, standardization, or order simplicity.',
      }
    )
    return sanitizeSuggestions(fallbacks)
  }

  if (currentQuestion && questionIntent && questionIntent !== 'meeting_coaching') {
    const topic = compactTopic(primaryTopic ?? currentQuestion)
    fallbacks.push(
      {
        id: generateId(),
        type: 'answer',
        title: `Answer on ${topic}`,
        detail: `They asked: "${currentQuestion}"${actionableQuestion ? ` [${actionableQuestion.timestamp}]` : ''}. Answer the question itself first, then add the one implication that matters in this conversation.`,
        say: buildKnowledgeSay(topic, questionCategory ?? 'general'),
        whyNow: 'A direct knowledge question is open, so the first card should answer it rather than coach around it.',
        listenFor: 'Whether they want more depth, a comparison, or the practical implication next.',
      },
      {
        id: generateId(),
        type: 'talking_point',
        title: `Name the ${topic} tradeoff`,
        detail: 'Move beyond definition into the practical trade-off or decision consequence. That is what makes the answer useful in a live conversation.',
        say: `The key thing to add on ${topic} is the trade-off or decision consequence, not just the definition.`,
        whyNow: 'A plain answer gets stronger when it includes the practical consequence.',
        listenFor: 'Which side of the trade-off or implication they care about most.',
      },
      {
        id: generateId(),
        type: 'question',
        title: `Clarify ${topic} constraints`,
        detail: 'Ask one narrow follow-up only if it would materially change the answer — for example scale, version, workflow, or timeline.',
        say: `What constraint matters most for ${topic} here — scale, version, workflow, or timing?`,
        whyNow: 'One focused clarifier can make the answer more precise without derailing it.',
        listenFor: 'The one variable that should shape the deeper answer.',
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
