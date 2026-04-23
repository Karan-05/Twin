import Groq from 'groq-sdk'
import { generateId, formatTimestamp } from './utils'
import { withRetry } from './retry'
import type { Suggestion, SuggestionBatch, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import { buildConversationSignalsSection, extractConversationSignals } from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import type { MeetingState } from './meetingState'
import { buildMeetingStateSection } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const VALID_TYPES = new Set(['question', 'talking_point', 'answer', 'fact_check', 'clarification'])
const OWNER_OR_TIMELINE_PATTERN = /\b(owner|who can|who owns|make the call|deadline|by when|tomorrow|friday|next step|follow up|escalat|workaround|qa|legal|security review|q[1-4])\b/i
const SUGGESTION_MAX_TOKENS = 650

// Meeting-type-specific personas with a single inline few-shot example showing the quality bar
const MEETING_PERSONAS: Record<string, string> = {
  'Sales Call': `You are a veteran enterprise sales strategist who has closed $200M+ in deals. You instantly read buying signals, hidden objections, and champion/blocker dynamics. You know the exact right question at the exact right moment is worth more than any pitch deck.

Quality example:
[JUST SAID] "We've looked at a few solutions and they're all pretty similar honestly."
→ [{"type":"fact_check","title":"'All similar' masks the real objection","detail":"This is a stall or a signal they're not the decision maker. Push gently: 'What would make one clearly stand out for you?' A great answer names the real criterion. A vague answer means the champion hasn't built internal buy-in — you need to escalate."},{"type":"question","title":"Map the full buying committee now","detail":"'All similar' often means consensus isn't built. Ask: 'Who else will weigh in on this before a decision?' Naming ops, finance, or legal early lets you shape the evaluation rather than react to it later."},{"type":"talking_point","title":"Anchor your differentiator then lock a next step","detail":"Counter the commoditization frame with your sharpest point tied to THEIR stated concern — then advance: 'If I can show you specifically how we handle [their stated concern], would it make sense to get your ops lead on a 30-minute call this week?'"}]`,

  'Job Interview': `You are a former FAANG hiring manager who has run 600+ interviews across engineering, product, and leadership. You know the signals that separate top-1% talent from good candidates, and you help both sides of the table get to signal faster.

Quality example:
[00:01:27] "Can you tell me about a time you had to make a decision with incomplete information?"
[JUST SAID] "Also, are you comfortable working across product, engineering, and support when things get busy?"
→ [{"type":"answer","title":"Answer the incomplete-information question first","detail":"The first question is the higher-signal behavioral ask. Lead with: 'We had three days to launch and the usage data was split — I polled two stakeholders, picked the option we could walk back, and shipped. [Your real outcome].' Three sentences: situation, the gap, how you decided anyway. The interviewer is listening for agency and a decision heuristic, not caution."},{"type":"answer","title":"Confirm cross-functional comfort with a story","detail":"Don't just say yes — demonstrate it: 'Yes — in my last role I ran the weekly incident call with eng, support, and PM during [your real crunch]. My job was to translate priorities, not just relay them.' One concrete cross-functional moment beats any claim about being a team player."},{"type":"question","title":"Ask how decisions get made under shifting priorities","detail":"After answering, probe: 'What's the team's default when you're 60% confident but the deadline is today?' A great answer reveals the operating model. A vague answer signals that decision norms aren't discussable — a red flag on a fast-moving team."}]`,

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

  for (const suggestion of suggestions) {
    const title = suggestion.title.replace(/\s+/g, ' ').trim()
    const detail = suggestion.detail.replace(/\s+/g, ' ').trim()
    if (!title || !detail) continue
    if (title.length < 6 || detail.length < 30) continue
    if (GENERIC_TITLE_PATTERN.test(title)) continue

    const key = title.toLowerCase()
    if (seenTitles.has(key)) continue
    const candidate = { title, detail }
    if (suggestion.type === 'question' && blockedQuestion && semanticSimilarity(candidate, blockedQuestion) >= 0.68) continue
    if (isSemanticDuplicate(candidate, cleaned)) continue
    if (isSemanticDuplicate(candidate, previousSuggestions)) continue
    seenTitles.add(key)

    cleaned.push({
      ...suggestion,
      title,
      detail,
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

  if (/(bilingual|spanish|translated|translation|operations team|equipo de operaciones|migración larga|migracion larga)/i.test(combinedText)) {
    score += 0.9
  }

  if ((meetingContext.prepNotes ?? '').toLowerCase().includes('bilingual') && /(operations|ops|finance|q4|internal approval|stall)/i.test(combinedText)) {
    score += 0.75
  }

  if (suggestion.say) score += 1.5
  if (suggestion.whyNow) score += 1
  if (suggestion.listenFor) score += 1
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

function buildFallbackSuggestions(recentChunks: TranscriptChunk[]): Suggestion[] {
  const signals = extractConversationSignals(recentChunks)
  const fallbacks: Suggestion[] = []

  if (signals.questions[0]) {
    fallbacks.push({
      id: generateId(),
      type: 'answer',
      title: 'Answer the open question',
      detail: `A direct question is still hanging: "${signals.questions[0].text}" [${signals.questions[0].timestamp}]. Give a concise answer now or ask one clarifying follow-up before the conversation moves on.`,
      say: 'Answer the question directly before the room moves on.',
      whyNow: 'An unanswered question is the highest-leverage interruption in the room.',
      listenFor: 'Whether they accept the answer or expose a deeper objection.',
    })
  }

  if (signals.risks[0]) {
    fallbacks.push({
      id: generateId(),
      type: 'clarification',
      title: 'Clarify the risky assumption',
      detail: `There is unresolved ambiguity in: "${signals.risks[0].text}" [${signals.risks[0].timestamp}]. Define the owner, timeline, or decision criterion now so this does not stay vague.`,
      say: 'Can we pin down the owner, timeline, and decision rule on this before we move on?',
      whyNow: 'The room is carrying ambiguity that will create downstream confusion.',
      listenFor: 'A named owner and a concrete deadline instead of vague agreement.',
    })
  }

  if (signals.numericClaims[0]) {
    fallbacks.push({
      id: generateId(),
      type: 'fact_check',
      title: 'Pressure-test the number',
      detail: `A concrete number or claim was stated: "${signals.numericClaims[0].text}" [${signals.numericClaims[0].timestamp}]. Ask for the source, assumption, or comparison point before everyone starts treating it as fact.`,
      say: 'What assumption or source is that number based on?',
      whyNow: 'Once a number lands, the room will start planning around it unless it is tested.',
      listenFor: 'A real source, baseline, or a sign the claim is softer than it sounds.',
    })
  }

  if (signals.commitments[0]) {
    fallbacks.push({
      id: generateId(),
      type: 'question',
      title: 'Lock the next step',
      detail: `A commitment surfaced in: "${signals.commitments[0].text}" [${signals.commitments[0].timestamp}]. Confirm the owner, exact deliverable, and timing so the meeting ends with a real next step.`,
      say: 'Before we wrap, who owns that exactly and by when?',
      whyNow: 'A soft commitment becomes real only when owner and timing are explicit.',
      listenFor: 'A named owner, a deliverable, and an actual date.',
    })
  }

  if (fallbacks.length === 0) {
    const latest = recentChunks[recentChunks.length - 1]
    const topic = extractConversationSignals(recentChunks).topics.slice(0, 2).join(' / ') || 'current topic'
    fallbacks.push(
      {
        id: generateId(),
        type: 'question',
        title: 'Expose the real blocker',
        detail: `Use the latest thread on ${topic} to ask what is actually blocking progress right now. If the answer stays vague, press for a concrete owner, constraint, or decision.`,
        say: 'What is the actual blocker here — owner, constraint, or decision?',
        whyNow: 'The conversation sounds fuzzy and needs a single forcing question.',
        listenFor: 'Whether the blocker is truly known or still hiding behind vague language.',
      },
      {
        id: generateId(),
        type: 'clarification',
        title: 'Define success explicitly',
        detail: `The current discussion still needs a sharper definition of success. Ask what outcome, deadline, or decision would make this topic resolved before the meeting moves on from [${latest?.timestamp ?? 'now'}].`,
        say: 'What outcome would make this topic resolved today?',
        whyNow: 'Without a decision rule, the room will keep circling.',
        listenFor: 'A concrete outcome or date instead of more brainstorming.',
      }
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
  const latestQuestionText = extractConversationSignals(promptChunks).questions[0]?.text
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

  suggestions = rankSuggestions(suggestions, promptChunks, meetingContext, options.meetingState)

  const fallbackSuggestions = buildFallbackSuggestions(promptChunks)
  for (const fallback of fallbackSuggestions) {
    if (suggestions.length >= 3) break
    if (isSemanticDuplicate(fallback, suggestions)) continue
    if (isSemanticDuplicate(fallback, previousSuggestions)) continue
    suggestions.push(fallback)
  }

  while (suggestions.length < 3) {
    const fallback: Suggestion = {
      id: generateId(),
      type: 'question',
      title: 'Confirm the next step',
      detail: 'Pause the discussion long enough to lock an owner, a deliverable, and a timeline. If nobody can name all three clearly, the meeting is still too vague.',
      say: 'What is the next step, who owns it, and by when?',
      whyNow: 'The room is close to ending without enough execution clarity.',
      listenFor: 'Owner, deliverable, and date — all three, not just one.',
    }
    if (!isSemanticDuplicate(fallback, suggestions) && !isSemanticDuplicate(fallback, previousSuggestions)) {
      suggestions.push(fallback)
      continue
    }
    suggestions.push({
      id: generateId(),
      type: 'clarification',
      title: 'Pin down the blocker',
      detail: 'Name the exact ambiguity or blocker keeping this conversation fuzzy. If no one can state it clearly, ask who owns resolving it and by when.',
      say: 'What exactly is still unclear, and who is resolving it?',
      whyNow: 'A final clarifying move is better than ending on mushy agreement.',
      listenFor: 'A clear blocker statement and an owner with a date.',
    })
  }

  return {
    id: generateId(),
    suggestions: suggestions.slice(0, 3),
    timestamp: formatTimestamp(new Date()),
    transcriptSnapshot,
  }
}
