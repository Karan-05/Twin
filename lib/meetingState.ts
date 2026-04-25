import type { MeetingContext, TranscriptChunk } from './store'
import type { QuestionIntent } from './contextSignals'
import { extractConversationSignals, extractPrimaryTopic, inferQuestionIntent, selectActionableQuestion } from './contextSignals'

export type SuggestionTriggerReason = 'question' | 'risky_claim' | 'blocker' | 'deadline' | 'loop' | 'focus_shift'

export interface MeetingState {
  mode: 'answer' | 'unblock' | 'decide' | 'probe' | 'close'
  currentQuestion: string | null
  questionIntent: QuestionIntent | null
  blocker: string | null
  riskyClaim: string | null
  decisionFocus: string | null
  deadlineSignal: string | null
  loopStatus: string | null
  stakeholderSignals: string[]
  triggerReason: SuggestionTriggerReason | null
  updatedAt: number | null
}

const EMPTY_STATE: MeetingState = {
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

const STAKEHOLDER_PATTERN = /\b(finance|ops|operations|design|legal|customer success|support|board|investor|recruiter|manager|lead|leadership|ceo|cto|cfo|sales|security|qa|product)\b/gi
const DEADLINE_PATTERN = /\b(today|tomorrow|friday|monday|tuesday|wednesday|thursday|next week|end of day|eod|deadline|this quarter|q[1-4])\b/i

function collectStakeholders(chunks: TranscriptChunk[], prepNotes?: string): string[] {
  const raw = `${chunks.map((chunk) => chunk.text).join(' ')} ${prepNotes ?? ''}`
  const matches = raw.match(STAKEHOLDER_PATTERN) ?? []
  return Array.from(new Set(matches.map((item) => item.toLowerCase()))).slice(0, 6)
}

function deriveLoopStatus(chunks: TranscriptChunk[]): string | null {
  const recent = chunks.slice(-4).map((chunk) => chunk.text.toLowerCase()).join(' ')
  if (/still|again|keeps looping|looping|same issue|same problem/.test(recent)) {
    return 'Conversation appears to be looping without a decision rule.'
  }

  const repeatedTopic = extractPrimaryTopic(chunks)
  if (repeatedTopic) {
    const count = chunks.filter((chunk) => chunk.text.toLowerCase().includes(repeatedTopic)).length
    if (count >= 3) {
      return `Topic "${repeatedTopic}" keeps recurring without obvious closure.`
    }
  }

  return null
}

function deriveDecisionFocus(chunks: TranscriptChunk[], ctx: MeetingContext, currentQuestion: string | null): string | null {
  const primaryTopic = extractPrimaryTopic(chunks, `${currentQuestion ?? ''} ${ctx.goal ?? ''}`)
  if (primaryTopic) return primaryTopic
  if (ctx.goal) return ctx.goal
  return null
}

export function deriveMeetingState(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  livePreviewText = ''
): MeetingState {
  const chunks = livePreviewText.trim()
    ? [...transcript, { id: 'live-preview', text: livePreviewText.trim(), timestamp: 'LIVE' }]
    : transcript

  if (chunks.length === 0) return EMPTY_STATE

  const signals = extractConversationSignals(chunks)
  const actionableQuestion = selectActionableQuestion(chunks, meetingContext)
  const currentQuestion = actionableQuestion?.text ?? null
  const questionIntent = actionableQuestion ? inferQuestionIntent(actionableQuestion.text, meetingContext) : null
  const blocker = signals.risks[0]?.text ?? null
  const riskyClaim = signals.numericClaims[0]?.text ?? null
  const deadlineSignal = signals.commitments.find((line) => DEADLINE_PATTERN.test(line.text))?.text
    ?? (signals.risks.find((line) => DEADLINE_PATTERN.test(line.text))?.text ?? null)
  const loopStatus = deriveLoopStatus(chunks)
  const decisionFocus = deriveDecisionFocus(chunks, meetingContext, currentQuestion)
  const stakeholderSignals = collectStakeholders(chunks, meetingContext.prepNotes)

  let mode: MeetingState['mode'] = 'probe'
  if (blocker && deadlineSignal) mode = 'unblock'
  else if (riskyClaim) mode = 'decide'
  else if (currentQuestion) mode = 'answer'
  else if (signals.commitments.length > 0) mode = 'close'

  let triggerReason: SuggestionTriggerReason | null = null
  if (blocker && deadlineSignal) triggerReason = 'deadline'
  else if (riskyClaim) triggerReason = 'risky_claim'
  else if (currentQuestion) triggerReason = 'question'
  else if (blocker) triggerReason = 'blocker'
  else if (deadlineSignal) triggerReason = 'deadline'
  else if (loopStatus) triggerReason = 'loop'
  else if (decisionFocus) triggerReason = 'focus_shift'

  return {
    mode,
    currentQuestion,
    questionIntent,
    blocker,
    riskyClaim,
    decisionFocus,
    deadlineSignal,
    loopStatus,
    stakeholderSignals,
    triggerReason,
    updatedAt: Date.now(),
  }
}

export function buildMeetingStateSection(meetingState: MeetingState): string {
  return [
    '## Meeting state',
    `Mode: ${meetingState.mode}`,
    `Current question: ${meetingState.currentQuestion ?? 'none'}`,
    `Question intent: ${meetingState.questionIntent ?? 'none'}`,
    `Blocker: ${meetingState.blocker ?? 'none'}`,
    `Risky claim: ${meetingState.riskyClaim ?? 'none'}`,
    `Decision focus: ${meetingState.decisionFocus ?? 'none'}`,
    `Deadline signal: ${meetingState.deadlineSignal ?? 'none'}`,
    `Loop status: ${meetingState.loopStatus ?? 'none'}`,
    `Stakeholders: ${meetingState.stakeholderSignals.length > 0 ? meetingState.stakeholderSignals.join(' · ') : 'none'}`,
  ].join('\n')
}
