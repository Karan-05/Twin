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
const MEMORY_WINDOW_DAYS = 30
const MEMORY_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'your', 'their', 'they', 'them', 'about', 'into',
  'what', 'when', 'where', 'which', 'would', 'could', 'should', 'will', 'just', 'really', 'very',
  'have', 'been', 'were', 'being', 'then', 'than', 'because', 'there', 'here', 'need', 'needs',
  'meeting', 'call', 'session', 'topic', 'thing', 'more', 'some', 'over', 'under',
])

export interface RelatedSessionQuery {
  meetingType?: string
  userRole?: string
  goal?: string
  queryText?: string
  withinDays?: number
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g)
    ?.filter((token) => !MEMORY_STOPWORDS.has(token)) ?? []
}

function buildSessionCorpus(session: SavedSession): string {
  return [
    session.meetingType,
    session.userRole,
    session.goal,
    session.summary.overview ?? '',
    ...session.summary.decisions,
    ...session.summary.actionItems,
    ...session.summary.keyData,
    ...session.summary.openQuestions,
    session.transcriptSample,
  ].join(' ')
}

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

export function findRelatedSessions(query: RelatedSessionQuery): SavedSession[] {
  const {
    meetingType = '',
    userRole = '',
    goal = '',
    queryText = '',
    withinDays = MEMORY_WINDOW_DAYS,
  } = query

  if (!meetingType && !userRole && !goal && !queryText) return []

  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000
  const queryTokens = tokenize(`${goal} ${queryText}`)

  return loadAllSessions()
    .filter((session) => new Date(session.date).getTime() > cutoff)
    .map((session) => {
      let score = 0

      if (meetingType && session.meetingType === meetingType) score += 4
      if (userRole && session.userRole === userRole) score += 1.25

      const corpus = buildSessionCorpus(session)
      const corpusTokens = new Set(tokenize(corpus))
      const overlap = queryTokens.filter((token) => corpusTokens.has(token)).length
      score += overlap * 0.85

      if (goal && session.goal && session.goal.toLowerCase() === goal.toLowerCase()) score += 1.5

      const ageDays = Math.max(0, (Date.now() - new Date(session.date).getTime()) / (24 * 60 * 60 * 1000))
      score += Math.max(0, 1 - (ageDays / withinDays))

      return { session, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.session)
}

export function buildPriorContextSection(sessions: SavedSession[]): string {
  if (sessions.length === 0) return ''
  const parts = sessions.map((s, i) => {
    const date = new Date(s.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const role = s.userRole ? ` · ${s.userRole}` : ''
    const overview = s.summary.overview ? `  Overview:\n  • ${s.summary.overview}` : ''
    const decisions = s.summary.decisions.slice(0, 2).map((d) => `  • ${d}`).join('\n') || '  • none captured'
    const actions = s.summary.actionItems.slice(0, 2).map((a) => `  • ${a}`).join('\n') || '  • none captured'
    const keyData = s.summary.keyData.slice(0, 2).map((k) => `  • ${k}`).join('\n')
    const openQuestions = s.summary.openQuestions.slice(0, 2).map((q) => `  • ${q}`).join('\n')
    return [
      `Relevant memory ${i + 1} (${date}${role}):`,
      overview,
      `  Decisions: \n${decisions}`,
      `  Open items:\n${actions}`,
      keyData ? `  Key data:\n${keyData}` : '',
      openQuestions ? `  Open questions:\n${openQuestions}` : '',
    ].filter(Boolean).join('\n')
  })
  return `## Relevant memory${sessions.length > 1 ? 'ies' : ''}\n${parts.join('\n\n')}`
}
