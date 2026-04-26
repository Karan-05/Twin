import type { MeetingContext, TranscriptChunk } from './store'
import {
  extractConversationSignals,
  extractPrimaryTopic,
  selectActionableQuestion,
} from './contextSignals'
import { deriveMeetingState, type MeetingState } from './meetingState'

export interface SecondBrainBrief {
  overview: string
  openLoop: string | null
  tension: string | null
  bestMove: string | null
  memoryAnchors: string[]
}

function toSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function compact(text: string | null | undefined, max = 120): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

function stripTrailingQuestion(text: string): string {
  return text.replace(/\?+$/, '').trim()
}

function buildOverview(topic: string | null, currentQuestion: string | null, latest: TranscriptChunk | undefined): string {
  if (topic && currentQuestion) {
    return toSentence(`The conversation is centered on ${topic}, and the main open question is ${stripTrailingQuestion(currentQuestion)}`)
  }
  if (currentQuestion) {
    return toSentence(`The main thing still open is ${stripTrailingQuestion(currentQuestion)}`)
  }
  if (topic) {
    return toSentence(`The conversation is centered on ${topic}`)
  }
  if (latest) {
    return toSentence(`The room is still working through ${compact(latest.text, 100) ?? 'the latest thread'}`)
  }
  return 'The room still needs a sharper read before it can move forward.'
}

function buildTension(
  meetingState: MeetingState,
  signals: ReturnType<typeof extractConversationSignals>,
  currentQuestion: string | null,
  topic: string | null
): string | null {
  if (meetingState.blocker && meetingState.deadlineSignal) {
    return toSentence(`The tension is not just ${compact(topic, 60) ?? 'the topic'} — it is that ${compact(meetingState.blocker, 110)} while timing pressure is already present`)
  }
  if (meetingState.riskyClaim && currentQuestion) {
    return toSentence(`The room is balancing the question itself against whether the supporting claim holds: ${compact(meetingState.riskyClaim, 110)}`)
  }
  if (meetingState.loopStatus) {
    return toSentence(meetingState.loopStatus)
  }
  if (signals.questions.length > 1 && currentQuestion) {
    const secondary = signals.questions.find((item) => item.text !== currentQuestion)
    if (secondary) {
      return toSentence(`There are two live threads: ${stripTrailingQuestion(currentQuestion)} and ${stripTrailingQuestion(secondary.text)}`)
    }
  }
  if (signals.risks[0]) {
    return toSentence(`The unresolved tension is ${compact(signals.risks[0].text, 120)}`)
  }
  return null
}

function buildBestMove(
  meetingState: MeetingState,
  meetingContext: MeetingContext,
  topic: string | null
): string | null {
  const intent = meetingState.questionIntent
  if (intent && intent !== 'meeting_coaching') {
    return toSentence(`Answer ${topic ?? 'the question'} directly first, then add the implication or constraint that changes the decision`)
  }
  if (meetingState.blocker && meetingState.deadlineSignal) {
    return 'Name the unblock owner, the slip risk, and the immediate workaround.'
  }
  if (meetingState.riskyClaim) {
    return 'Pressure-test the number or claim before the room plans around it.'
  }
  if (meetingState.mode === 'close') {
    return 'Lock the owner, deliverable, and timing before the room moves on.'
  }
  if (meetingContext.goal) {
    return toSentence(`Re-anchor the room on ${meetingContext.goal}`)
  }
  return 'Surface the one concrete outcome the room needs before it can move on.'
}

function buildMemoryAnchors(
  topic: string | null,
  meetingState: MeetingState,
  signals: ReturnType<typeof extractConversationSignals>
): string[] {
  const anchors: string[] = []

  if (topic) anchors.push(`Topic: ${topic}`)
  if (meetingState.currentQuestion) {
    const openLoop = compact(meetingState.currentQuestion, 90)
    if (openLoop) anchors.push(`Open question: ${openLoop}`)
  }
  if (signals.numericClaims[0]) {
    const claim = compact(signals.numericClaims[0].text, 90)
    if (claim) anchors.push(`Claim to verify: ${claim}`)
  }
  if (signals.commitments[0]) {
    const commitment = compact(signals.commitments[0].text, 90)
    if (commitment) anchors.push(`Commitment: ${commitment}`)
  }
  if (meetingState.deadlineSignal) {
    const deadline = compact(meetingState.deadlineSignal, 90)
    if (deadline) anchors.push(`Timing signal: ${deadline}`)
  }
  if (meetingState.stakeholderSignals.length > 0) {
    anchors.push(`Stakeholders: ${meetingState.stakeholderSignals.join(', ')}`)
  }

  return anchors.slice(0, 4)
}

export function deriveSecondBrainBrief(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  meetingState?: MeetingState
): SecondBrainBrief {
  const effectiveMeetingState = meetingState ?? deriveMeetingState(transcript, meetingContext)
  const signals = extractConversationSignals(transcript)
  const actionableQuestion = selectActionableQuestion(transcript, meetingContext)
  const currentQuestion = effectiveMeetingState.currentQuestion ?? actionableQuestion?.text ?? null
  const topic = extractPrimaryTopic(
    transcript,
    `${currentQuestion ?? ''} ${meetingContext.goal ?? ''}`
  ) ?? effectiveMeetingState.decisionFocus ?? null
  const latest = transcript[transcript.length - 1]
  const overview = buildOverview(topic, currentQuestion, latest)
  const openLoop = currentQuestion ? toSentence(stripTrailingQuestion(currentQuestion)) : null
  const tension = buildTension(effectiveMeetingState, signals, currentQuestion, topic)
  const bestMove = buildBestMove(effectiveMeetingState, meetingContext, topic)
  const memoryAnchors = buildMemoryAnchors(topic, effectiveMeetingState, signals)

  return {
    overview,
    openLoop,
    tension,
    bestMove,
    memoryAnchors,
  }
}

export function buildSecondBrainBriefSection(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  meetingState?: MeetingState
): string {
  const brief = deriveSecondBrainBrief(transcript, meetingContext, meetingState)
  const lines = [
    '## Second-brain brief',
    `What this is about: ${brief.overview}`,
  ]

  if (brief.openLoop) lines.push(`Main open loop: ${brief.openLoop}`)
  if (brief.tension) lines.push(`Hidden tension: ${brief.tension}`)
  if (brief.bestMove) lines.push(`Best move now: ${brief.bestMove}`)
  if (brief.memoryAnchors.length > 0) {
    lines.push(`Memory anchors: ${brief.memoryAnchors.join(' | ')}`)
  }

  return lines.join('\n')
}
