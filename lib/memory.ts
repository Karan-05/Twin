import type { IntelligenceSummary } from './store'

export interface SavedSession {
  id: string
  date: string
  meetingType: string
  userRole: string
  goal: string
  summary: IntelligenceSummary
  transcriptSample: string
}

const KEY = 'meeting_copilot_sessions'
const MAX_SESSIONS = 15

export function saveSession(data: Omit<SavedSession, 'id'>): void {
  if (typeof window === 'undefined') return
  const existing = loadAllSessions()
  const next = [{ id: Date.now().toString(), ...data }, ...existing].slice(0, MAX_SESSIONS)
  localStorage.setItem(KEY, JSON.stringify(next))
}

export function loadAllSessions(): SavedSession[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export function findRelatedSessions(meetingType: string, withinDays = 7): SavedSession[] {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000
  return loadAllSessions()
    .filter((s) => s.meetingType === meetingType && new Date(s.date).getTime() > cutoff)
    .slice(0, 3)
}

export function buildPriorContextSection(sessions: SavedSession[]): string {
  if (sessions.length === 0) return ''
  const parts = sessions.map((s, i) => {
    const date = new Date(s.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const role = s.userRole ? ` · ${s.userRole}` : ''
    const decisions = s.summary.decisions.slice(0, 2).map((d) => `  • ${d}`).join('\n') || '  • none captured'
    const actions = s.summary.actionItems.slice(0, 2).map((a) => `  • ${a}`).join('\n') || '  • none captured'
    const keyData = s.summary.keyData.slice(0, 2).map((k) => `  • ${k}`).join('\n')
    return [
      `Prior session ${i + 1} (${date}${role}):`,
      `  Decisions: \n${decisions}`,
      `  Open items:\n${actions}`,
      keyData ? `  Key data:\n${keyData}` : '',
    ].filter(Boolean).join('\n')
  })
  return `## Memory: ${sessions.length} prior ${sessions[0].meetingType} session${sessions.length > 1 ? 's' : ''}\n${parts.join('\n\n')}`
}
