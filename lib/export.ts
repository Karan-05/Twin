import type { TranscriptChunk, SuggestionBatch, Message } from './store'

export function exportSession(
  transcript: TranscriptChunk[],
  suggestionBatches: SuggestionBatch[],
  messages: Message[],
  sessionTitle: string
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
    transcript,
    suggestionBatches,
    chatMessages: messages,
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
