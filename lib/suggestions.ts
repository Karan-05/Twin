import Groq from 'groq-sdk'
import { generateId, formatTimestamp } from './utils'
import { withRetry } from './retry'
import type { Suggestion, SuggestionBatch, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import { buildConversationSignalsSection, extractConversationSignals, extractPrimaryTopic } from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import type { MeetingState } from './meetingState'
import { buildMeetingStateSection } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const VALID_TYPES = new Set(['question', 'talking_point', 'answer', 'fact_check', 'clarification'])
const OWNER_OR_TIMELINE_PATTERN = /\b(owner|who can|who owns|make the call|deadline|by when|tomorrow|friday|next step|follow up|escalat|workaround|qa|legal|security review|q[1-4])\b/i
const SUGGESTION_MAX_TOKENS = 900

// Common English words that appear sentence-initial (capitalized) in speech transcripts but
// are not topic labels. Stopwords do the semantic work; length >= 4 handles the residual
// 2–3-char words (And, Can, So, Hey, etc.).
const TOPIC_LABEL_STOPWORDS = new Set([
  'him', 'his', 'her', 'its', 'our', 'you', 'your', 'they', 'them', 'their',
  'are', 'ask', 'been', 'being', 'can', 'come', 'could', 'did', 'does', 'done',
  'give', 'get', 'gets', 'going', 'got', 'had', 'has', 'have', 'help', 'keep',
  'know', 'let', 'look', 'make', 'may', 'might', 'move', 'must', 'need', 'put',
  'run', 'said', 'say', 'see', 'set', 'should', 'show', 'take', 'tell', 'think',
  'try', 'turn', 'used', 'want', 'was', 'went', 'were', 'will', 'with', 'work',
  'would', 'also', 'away', 'back', 'basically', 'definitely', 'down', 'each',
  'even', 'every', 'exactly', 'few', 'first', 'good', 'high', 'how', 'just',
  'kind', 'last', 'like', 'long', 'low', 'many', 'more', 'most', 'much', 'never',
  'new', 'next', 'not', 'now', 'off', 'often', 'okay', 'only', 'out', 'over',
  'own', 'quite', 'rather', 'really', 'right', 'same', 'some', 'still', 'such',
  'sure', 'than', 'then', 'there', 'these', 'those', 'through', 'too', 'under',
  'until', 'upon', 'usually', 'very', 'well', 'whether', 'while', 'yet',
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'about', 'above', 'across', 'after', 'against', 'ahead', 'along', 'although',
  'always', 'among', 'another', 'around', 'because', 'before', 'below',
  'between', 'both', 'but', 'during', 'either', 'enough', 'except', 'following',
  'for', 'from', 'further', 'hence', 'however', 'including', 'instead', 'into',
  'nothing', 'once', 'overall', 'perhaps', 'please', 'several', 'simply',
  'since', 'somehow', 'something', 'sometimes', 'somewhere', 'that', 'therefore',
  'this', 'though', 'together', 'toward', 'whatever', 'whenever', 'wherever',
  'within', 'without', 'absolutely', 'actually', 'again', 'already', 'sorry',
  'thank', 'thanks', 'yeah', 'yes', 'hey', 'hello',
  // number words that appear as garbled transcription artifacts
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
  'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion',
  // generic filler words that produce low-value topic labels
  'thing', 'things', 'point', 'points', 'issue', 'issues', 'item', 'items',
  'part', 'parts', 'side', 'time', 'times', 'type', 'types', 'way', 'ways',
  'place', 'case', 'cases', 'fact', 'facts', 'area', 'areas', 'level', 'levels',
  'data', 'note', 'notes', 'step', 'steps', 'word', 'words', 'line', 'lines',
  // adjectives/adverbs that shouldn't be standalone topic labels
  'real', 'always', 'never', 'every', 'human', 'based', 'available', 'working',
  'actual', 'entire', 'general', 'certain', 'specific', 'different', 'important',
  'large', 'small', 'long', 'short', 'high', 'able', 'using', 'used',
])

function extractTopicLabels(chunks: TranscriptChunk[]): string[] {
  const combined = chunks.map((chunk) => chunk.text).join(' ')
  const matches = combined.match(/\b(?:[A-Z][a-z]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|AI|Speech|Studio|Audio|Labs))*\b/g) ?? []
  const cleaned = matches
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
    .filter((item) => !TOPIC_LABEL_STOPWORDS.has(item.toLowerCase()))
    .filter((item) => !TOPIC_LABEL_STOPWORDS.has(item.split(' ').pop()!.toLowerCase()))

  return Array.from(new Set(cleaned)).slice(0, 5)
}

function compactTopic(topic?: string): string {
  if (!topic) return 'latest topic'
  return topic.length > 28 ? `${topic.slice(0, 25).trimEnd()}…` : topic
}

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

Quality example — TECHNICAL question:
[JUST SAID] "How do voice AI agents work in production, and how do you scale them to millions of users?"
→ [{"type":"answer","title":"Explain the voice AI pipeline end-to-end","detail":"Cover: (1) ASR — speech-to-text via Whisper or a streaming ASR model, (2) NLU/LLM — intent extraction and response generation, (3) TTS — text-to-speech synthesis streamed back. The key production insight is streaming: you pipe ASR output to the LLM as it arrives, and start TTS on the first sentence — so the user hears a response in ~300ms end-to-end instead of waiting for the full generation.","say":"The pipeline is ASR → LLM → TTS, but the production trick is streaming all three in parallel — ASR feeds the LLM as words arrive, TTS starts on the first sentence, so latency is under 300–500ms end-to-end rather than waiting for the full response."},{"type":"talking_point","title":"Address hallucination prevention proactively","detail":"Before they ask: RAG (retrieval-augmented generation) grounds the LLM in real knowledge, confidence scoring detects low-certainty outputs so the agent says 'I'm not sure' instead of guessing, and human-in-the-loop routing handles edge cases. Mention one real tradeoff: RAG adds latency, so you cache embeddings and pre-fetch likely queries.","say":"To prevent hallucination we use RAG to ground answers in real data, add a confidence threshold so the agent says 'I need to check on that' instead of guessing, and route low-confidence turns to a human or a safer fallback response."},{"type":"question","title":"Clarify their scale and latency SLA","detail":"'When you say millions — is that concurrent or daily active? And what's your latency target?' This shows systems thinking and anchors the architecture discussion. A strong answer names a real constraint (e.g. 200ms target, 50k concurrent). A vague answer means the problem is still exploratory — ask what their current pain point is.","say":"When you say millions — is that concurrent users or daily active? And what latency target are you designing for?"}]`,

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
  // Exact-title-only for cross-batch dedup: semantic at 0.72 blocks all same-domain angles
  // on narrow-topic meetings where the same keywords appear in every batch.
  const prevTitleKeys = new Set(previousSuggestions.map((s) => s.title.trim().toLowerCase()))

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
    if (prevTitleKeys.has(key)) continue
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

export function buildFallbackSuggestions(recentChunks: TranscriptChunk[]): Suggestion[] {
  const signals = extractConversationSignals(recentChunks)
  const topicLabels = extractTopicLabels(recentChunks)
  const latest = recentChunks[recentChunks.length - 1]
  const fallbacks: Suggestion[] = []

  const rawPrimary = extractPrimaryTopic(recentChunks) || topicLabels[0] || signals.topics[0] || ''
  const primaryTopic = rawPrimary.length >= 4 ? rawPrimary : 'latest topic'
  const comparisonSet = topicLabels.slice(0, 4)
  const comparisonText = comparisonSet.length > 1 ? comparisonSet.join(', ') : primaryTopic

  if (signals.questions[0]) {
    const question = signals.questions[0]
    const hasShortlist = comparisonSet.length >= 2

    const TECHNICAL_RE = /how (does|do|can|to)|architect|pipeline|scale|real.?time|latency|hallucin|production|inference|accuracy|model|deploy|securi|api\b|integrat|implement/i
    const rawText = [question.text, ...recentChunks.map((c) => c.text)].join(' ')

    if (TECHNICAL_RE.test(rawText)) {
      const topic = primaryTopic || 'the system'
      const llmLike = /\b(llm|large language model|tokenization|tokenisation|embedding|embeddings|attention|transformer)\b/i.test(`${topic} ${rawText}`)

      if (llmLike) {
        fallbacks.push({
          id: generateId(),
          type: 'answer',
          title: 'Explain how an LLM works',
          detail: `They asked: "${question.text}" [${question.timestamp}]. Walk through the runtime path in order: text is tokenized, tokens become embeddings, transformer attention layers build context across the sequence, and the model predicts the next token repeatedly until it forms the answer.`,
          say: `An LLM first tokenizes the input, maps those tokens to embeddings, runs transformer attention layers to build context, and then predicts the next token repeatedly until the response is complete.`,
          whyNow: 'This is a direct technical question, so a concrete runtime explanation is more useful than a generic framework.',
          listenFor: 'Whether they want the training story next, or a deeper dive on embeddings, attention, or decoding.',
        })

        fallbacks.push({
          id: generateId(),
          type: 'talking_point',
          title: 'Separate tokens from embeddings',
          detail: `Tokenization and embeddings are not the same step. Tokenization breaks text into units the model can process; embeddings turn each token into a vector so attention layers can compare meaning and context across the sequence.`,
          say: `Tokenization chops the text into model-sized pieces, and embeddings turn those pieces into vectors the transformer can reason over — that separation is the key thing to explain clearly.`,
          whyNow: 'People often blur these two steps together, which makes the explanation feel fuzzy fast.',
          listenFor: 'Whether they are asking about the runtime path, or they actually want training internals and representation learning.',
        })

        fallbacks.push({
          id: generateId(),
          type: 'question',
          title: 'Clarify training vs inference',
          detail: `Ask whether they want the training story or the runtime inference path. Training is large-scale next-token prediction over huge corpora; inference is the live loop that predicts one token at a time using the trained weights.`,
          say: `Do you want the training story, or the runtime inference path from prompt to generated answer? That changes the explanation a lot.`,
          whyNow: 'That one split keeps the answer sharp instead of mixing two different layers of the system.',
          listenFor: 'Whether they care more about model learning, or about how a prompt becomes a live answer.',
        })

        return sanitizeSuggestions(fallbacks)
      }

      fallbacks.push({
        id: generateId(),
        type: 'answer',
        title: `Explain ${compactTopic(topic)} architecture`,
        detail: `They asked: "${question.text}" [${question.timestamp}]. Walk through in order: (1) the input path, (2) the core processing loop, (3) the output path, and (4) the main production bottleneck that shapes the design.`,
        say: `I'd explain ${topic} in four parts: input, core processing, output, and the main production bottleneck that drives the real trade-offs.`,
        whyNow: 'A direct technical question just landed — architecture first, trade-offs second, proof third.',
        listenFor: 'Whether they want depth on a specific component, the trade-offs, or your hands-on experience.',
      })

      fallbacks.push({
        id: generateId(),
        type: 'talking_point',
        title: `Name ${compactTopic(topic)}'s production bottleneck`,
        detail: `Every system has one dominant production challenge. For ${topic} it could be latency, consistency, throughput, accuracy, or operational complexity — naming it precisely separates a credible answer from a textbook one.`,
        say: `The main production challenge with ${topic} is [specific bottleneck] — here's how we addressed it: [your real example and outcome].`,
        whyNow: 'Production specifics separate hands-on experience from surface-level knowledge.',
        listenFor: 'Whether they push back on the bottleneck you named — that reveals their own depth with the system.',
      })

      fallbacks.push({
        id: generateId(),
        type: 'question',
        title: `Clarify ${compactTopic(topic)} scale and constraints`,
        detail: `Architecture decisions for ${topic} change significantly at different scales — what works at 100 users can break at 1M, and latency vs. consistency trade-offs depend entirely on the use case.`,
        say: `What scale and constraints are you targeting with ${topic} — latency budget, consistency requirements, throughput? Those shape the whole design.`,
        whyNow: 'Scale and constraints determine the architecture — clarifying them focuses the technical discussion.',
        listenFor: 'Concrete numbers and requirements that let you tailor the technical depth to what actually matters.',
      })

      return sanitizeSuggestions(fallbacks)
    }

    fallbacks.push({
      id: generateId(),
      type: 'answer',
      title: `Answer on ${compactTopic(primaryTopic)}`,
      detail: hasShortlist
        ? `They explicitly asked: "${question.text}" [${question.timestamp}]. Answer by anchoring on ${primaryTopic} and comparing it directly against ${comparisonText} — pick one axis (quality, cost, workflow fit) and stick with it.`
        : `They explicitly asked: "${question.text}" [${question.timestamp}]. Answer directly on ${primaryTopic}: lead with your sharpest point, support it with one concrete fact, then invite a follow-up.`,
      say: hasShortlist
        ? `Let me anchor on ${primaryTopic}: compared with ${comparisonSet.slice(1, 3).join(' and ')}, the key difference is — [your specific point].`
        : `Here's the direct answer on ${primaryTopic}: [your key point] — and here's why that matters for your use case.`,
      whyNow: 'A direct question just landed — a focused, specific answer beats a broad overview every time.',
      listenFor: 'A concrete follow-up criterion (quality, cost, fit) that tells you which angle they actually care about.',
    })

    if (hasShortlist) {
      fallbacks.push({
        id: generateId(),
        type: 'question',
        title: 'Choose the comparison axis',
        detail: `The transcript names ${comparisonText}. Ask which single dimension they care about most so you compare on one axis instead of giving a wandering overview.`,
        say: `Which matters most here — quality, cost, workflow fit, or how ${primaryTopic} integrates into your existing stack?`,
        whyNow: 'That one question turns a generic overview into a targeted recommendation.',
        listenFor: 'A concrete criterion instead of more names or general exploration.',
      })

      fallbacks.push({
        id: generateId(),
        type: 'talking_point',
        title: `Compare ${compactTopic(primaryTopic)} against the shortlist`,
        detail: `You already named ${comparisonText}${latest ? ` by [${latest.timestamp}]` : ''}. Compare ${primaryTopic} directly against that list on one axis — don't restart from definitions.`,
        say: `Since we've already named ${comparisonText}, let me compare ${primaryTopic} directly against that shortlist on [quality / cost / fit].`,
        whyNow: 'The conversation has enough named options for a direct comparison — no need to re-introduce.',
        listenFor: 'Whether they want a recommendation, a technical comparison, or a workflow fit.',
      })
    } else {
      fallbacks.push({
        id: generateId(),
        type: 'question',
        title: `Anchor the evaluation criteria`,
        detail: `The question about ${primaryTopic} needs a lens. Ask what they're optimizing for — one answer turns an overview into a targeted recommendation.`,
        say: `What are you optimizing for with ${primaryTopic} — quality, cost, workflow fit, or a specific use case?`,
        whyNow: 'A concrete criterion shapes the answer and prevents a wandering overview.',
        listenFor: 'A specific use case or constraint that lets you give a direct recommendation.',
      })

      fallbacks.push({
        id: generateId(),
        type: 'talking_point',
        title: `Name the key tradeoff on ${compactTopic(primaryTopic)}`,
        detail: `Move beyond description to the real tradeoff. The most useful thing you can say about ${primaryTopic} is what you'd have to give up to use it — that's what drives decisions.`,
        say: `The key tradeoff with ${primaryTopic} is [quality vs. cost / flexibility vs. reliability / ease vs. control] — which side matters more for you?`,
        whyNow: 'Naming the tradeoff forces specificity and usually gets a faster, more useful reply than a general pitch.',
        listenFor: 'Which side of the tradeoff they land on — that shapes the rest of the recommendation.',
      })
    }

    return sanitizeSuggestions(fallbacks)
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
    const rawTextAll = recentChunks.map((c) => c.text).join(' ')
    const TECHNICAL_RE_BROAD = /how (does|do|can|to)|architect|pipeline|scale|real.?time|latency|hallucin|production|inference|accuracy|model|deploy|securi|implement|design\b/i

    if (TECHNICAL_RE_BROAD.test(rawTextAll)) {
      const topic = primaryTopic || 'the system'
      const llmLike = /\b(llm|large language model|tokenization|tokenisation|embedding|embeddings|attention|transformer)\b/i.test(`${topic} ${rawTextAll}`)

      if (llmLike) {
        fallbacks.push(
          {
            id: generateId(),
            type: 'answer',
            title: 'Explain how an LLM works',
            detail: `Walk through the runtime path clearly: tokenization, embeddings, transformer attention, then next-token decoding. That sequence answers most "how does an LLM work?" questions much better than abstract AI language.`,
            say: `An LLM tokenizes the input, converts tokens into embeddings, runs attention across the sequence to build context, and then predicts the next token repeatedly until it completes the answer.`,
            whyNow: 'This is a technical explainer moment, so the concrete runtime path is the highest-value move.',
            listenFor: 'Whether they want to go deeper on embeddings, attention, or the training loop next.',
          },
          {
            id: generateId(),
            type: 'talking_point',
            title: 'Separate tokenization from meaning',
            detail: `Make the distinction explicit: tokenization is text segmentation, embeddings are learned numerical representations, and attention is what mixes context across the sequence. That clears up where the model's "sense of the task" actually comes from.`,
            say: `The model doesn't understand first and answer later — context emerges because attention layers keep updating the token representations as the sequence is processed.`,
            whyNow: 'That distinction is where most fuzzy explanations go wrong.',
            listenFor: 'Whether they are actually confused about embeddings, or about the transformer inference loop more broadly.',
          },
          {
            id: generateId(),
            type: 'question',
            title: 'Clarify training vs inference',
            detail: `Ask whether they want the offline training process or the live inference path. Those are related but different explanations, and mixing them is what usually makes the answer muddy.`,
            say: `Do you want the training explanation, or the inference path from prompt to generated answer?`,
            whyNow: 'That keeps the explanation clean instead of blending two different system layers.',
            listenFor: 'Which part of the stack they actually care about next.',
          }
        )
        return sanitizeSuggestions(fallbacks)
      }

      fallbacks.push(
        {
          id: generateId(),
          type: 'answer',
          title: `Explain ${compactTopic(topic)} architecture`,
          detail: `Walk through in order: the input path, the core processing loop, the output path, and the main production bottleneck. Architecture first, trade-offs second, proof third.`,
          say: `I'd explain ${topic} as input, core processing, output, and the main bottleneck that changes the design trade-offs.`,
          whyNow: 'There is a technical question in the conversation — the architecture framework is the right opening move.',
          listenFor: 'Whether they want depth on a specific component, the trade-offs, or your hands-on experience.',
        },
        {
          id: generateId(),
          type: 'talking_point',
          title: `Name ${compactTopic(topic)}'s production bottleneck`,
          detail: `Every system has one dominant production challenge. For ${topic} it could be latency, consistency, throughput, accuracy, or operational complexity — naming it precisely separates a credible answer from a textbook one.`,
          say: `The main production challenge with ${topic} is [specific bottleneck] — here's how we addressed it: [your real example and outcome].`,
          whyNow: 'Production specifics show real hands-on experience.',
          listenFor: 'Whether they challenge the bottleneck you named — that reveals their actual system depth.',
        },
        {
          id: generateId(),
          type: 'question',
          title: `Clarify ${compactTopic(topic)} scale and constraints`,
          detail: `Architecture decisions for ${topic} change significantly at different scales — what works at 100 users can break at 1M, and latency vs. consistency trade-offs depend entirely on the use case.`,
          say: `What scale and constraints are you targeting with ${topic} — latency budget, consistency requirements, throughput? Those shape the whole design.`,
          whyNow: 'Scale and constraints determine the architecture — knowing them prevents wasted explanation.',
          listenFor: 'Concrete numbers and requirements that let you tailor the technical depth.',
        }
      )
      return sanitizeSuggestions(fallbacks)
    }

    const topic = signals.topics.slice(0, 2).join(' / ') || primaryTopic || 'current topic'
    fallbacks.push(
      {
        id: generateId(),
        type: 'talking_point',
        title: `Re-anchor on ${compactTopic(primaryTopic)}`,
        detail: `The live thread is really about ${topic}. Summarize it in one sharp line and move the room toward a recommendation, comparison, or decision instead of letting it stay as a loose overview.`,
        say: `The real thread here is ${primaryTopic} — let me narrow this to the one recommendation or comparison that matters most.`,
        whyNow: 'The conversation has topic signal, but not enough structure yet.',
        listenFor: 'Whether they want a recommendation, a comparison, or a deeper technical breakdown.',
      },
      {
        id: generateId(),
        type: 'question',
        title: 'Ask for the use case',
        detail: `The fastest way to make ${primaryTopic} useful is to ask what they are actually optimizing for — evaluation, creator workflow, multilingual coverage, or production use.`,
        say: `Before I go broader, what use case are we optimizing for with ${primaryTopic}?`,
        whyNow: 'That turns a generic explainer into a relevant recommendation.',
        listenFor: 'A concrete use case you can answer against instead of abstract interest.',
      },
      {
        id: generateId(),
        type: 'clarification',
        title: 'Define the decision rule',
        detail: `The discussion still needs a sharper decision rule. Ask what outcome, comparison, or next step would make this topic resolved before the meeting moves on${latest ? ` from [${latest.timestamp}]` : ''}.`,
        say: 'What would make this topic resolved today — a recommendation, a comparison, or a concrete next step?',
        whyNow: 'Without a decision rule, the room will keep circling.',
        listenFor: 'A concrete outcome instead of more broad explanation.',
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

  const fallbackSuggestions = buildFallbackSuggestions(promptChunks)
  const previousTitleKeys = new Set(previousSuggestions.map((s) => s.title.trim().toLowerCase()))
  for (const fallback of fallbackSuggestions) {
    if (suggestions.length >= 3) break
    if (isSemanticDuplicate(fallback, suggestions)) continue
    // Only block exact-title repeats from previous batches — topic-aware fallbacks are
    // always better than the generic while-loop ones, even if topically similar.
    if (previousTitleKeys.has(fallback.title.trim().toLowerCase())) continue
    suggestions.push(fallback)
  }

  // Build context for topic-aware last-resort pads
  const padSignals = extractConversationSignals(promptChunks)
  const padTopicLabels = extractTopicLabels(promptChunks)
  const padTopic = padTopicLabels[0] || padSignals.topics[0] || null
  const padTopicStr = padTopic ? compactTopic(padTopic) : 'this topic'
  const padQuestion = padSignals.questions[0]?.text || null

  // Single last-resort pad — 2 real suggestions + 1 contextual pad beats 3 generic ones.
  if (suggestions.length < 3) {
    const pad: Suggestion = padQuestion
      ? {
          id: generateId(),
          type: 'answer',
          title: `Answer their ${padTopicStr} question directly`,
          detail: `An open question is waiting: "${padQuestion.slice(0, 90)}${padQuestion.length > 90 ? '…' : ''}" — give a focused answer rather than a broad overview.`,
          say: `Here's the direct answer on ${padTopicStr}: what matters most is…`,
          whyNow: 'A direct question is open — a focused answer moves things forward faster than a general explanation.',
          listenFor: 'Whether the answer resolves their question or surfaces a more specific need.',
        }
      : {
          id: generateId(),
          type: 'question',
          title: `Get specific on ${padTopicStr}`,
          detail: `Move from overview to specifics on ${padTopic || 'the current topic'} — one sharp question unlocks a concrete recommendation instead of continuing broadly.`,
          say: `What's the most important thing to nail about ${padTopicStr} — quality, speed, cost, or fit for your use case?`,
          whyNow: 'The conversation needs a sharper focus to produce something actionable.',
          listenFor: 'A concrete priority or use case rather than continued general exploration.',
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
