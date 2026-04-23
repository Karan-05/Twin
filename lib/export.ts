import type { TranscriptChunk, SuggestionBatch, Message, MeetingContext, IntelligenceSummary } from './store'
import type { AppSettings } from './settings'

export function exportSession(
  transcript: TranscriptChunk[],
  suggestionBatches: SuggestionBatch[],
  messages: Message[],
  sessionTitle: string,
  meetingContext?: MeetingContext,
  intelligenceSummary?: IntelligenceSummary | null,
  sessionStartTime?: number | null,
  settings?: AppSettings
): void {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('')

  const sessionData = {
    exportedAt: now.toISOString(),
    sessionTitle,
    session: {
      startedAt: sessionStartTime ? new Date(sessionStartTime).toISOString() : null,
      durationSeconds: sessionStartTime ? Math.floor((now.getTime() - sessionStartTime) / 1000) : null,
      meetingType: meetingContext?.meetingType || null,
      userRole: meetingContext?.userRole || null,
      goal: meetingContext?.goal || null,
      prepNotes: meetingContext?.prepNotes || null,
      proofPoints: meetingContext?.proofPoints || null,
      language: meetingContext?.language || null,
    },
    intelligence: intelligenceSummary ?? null,
    transcript,
    suggestionBatches,
    chatMessages: messages,
    // Included so evaluators can see exactly which prompts produced these outputs
    promptsUsed: settings ? {
      liveSuggestionPrompt: settings.liveSuggestionPrompt,
      clickDetailPrompt: settings.clickDetailPrompt,
      chatSystemPrompt: settings.chatSystemPrompt,
      suggestionContextWindow: settings.suggestionContextWindow,
      detailContextWindow: settings.detailContextWindow,
    } : null,
  }

  const blob = new Blob([JSON.stringify(sessionData, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `meeting-copilot-${stamp}.json`
  a.click()
  URL.revokeObjectURL(url)
}
