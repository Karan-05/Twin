import type { TranscriptChunk } from './store'

export interface SignalLine {
  timestamp: string
  text: string
}

export interface ConversationSignals {
  topics: string[]
  questions: SignalLine[]
  numericClaims: SignalLine[]
  commitments: SignalLine[]
  risks: SignalLine[]
  multilingualCues: SignalLine[]
}

const QUESTION_PREFIXES = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'would', 'could', 'should', 'can', 'do',
  'does', 'did', 'is', 'are', 'was', 'were', 'will', 'have', 'has', 'had'
]

// Matches STT-style indirect questions: "So hey can you tell me..." / "Well actually how does..."
// Allows 1-3 filler words before a question word (STT rarely produces punctuation)
const INDIRECT_QUESTION_RE = /^(?:(?:so|hey|well|um|uh|and|but|also|okay|right|yeah|now|like|alright|actually|basically)\s+){1,3}(?:can|could|would|should|how|what|why|when|where|who|which|will|do|does|did|is|are|was|were|have|has|had)\b/i

const COMMITMENT_PATTERN = /\b(will|i'll|we'll|going to|next step|follow up|send|share|deliver|commit|owner|deadline|by\s+(monday|tuesday|wednesday|thursday|friday|tomorrow|next week|end of day|eod|q[1-4]))\b/i
const RISK_PATTERN = /\b(not sure|unsure|maybe|depends|blocked|blocker|risk|concern|issue|problem|later|eventually|someday|hard|difficult|can't|cannot|won't|similar|nice to have|budget|timeline|approval)\b/i
const NUMBER_PATTERN = /(?:\$|€|£|¥)?\b\d+(?:[.,]\d+)?\s*(?:%|percent|k|m|b|million|billion|days?|weeks?|months?|years?)?\b/i
const MULTILINGUAL_PATTERN = /[^\x00-\x7F]|\b(sí|si|porque|equipo|operaciones|trimestre|gracias|hola|vale|pero|también|tambien|necesita|necesitamos|migraci[oó]n|largo|larga)\b/i

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'they', 'them', 'their', 'there', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'when', 'what', 'where', 'while', 'which',
  'who', 'your', 'you', 'our', 'ours', 'we', 'us', 'for', 'are', 'was', 'were', 'been', 'being',
  'will', 'just', 'said', 'says', 'also', 'only', 'really', 'very', 'more', 'most', 'much', 'many',
  'some', 'like', 'kind', 'sort', 'need', 'want', 'make', 'made', 'does', 'doing', 'did', 'done',
  'can', 'cant', 'cannot', 'not', 'yes', 'yeah', 'okay', 'well', 'right', 'maybe', 'into', 'over',
  'under', 'than', 'after', 'before', 'because', 'through', 'across', 'around', 'meeting', 'call'
])

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function splitSentences(text: string): string[] {
  return cleanText(text)
    .split(/(?<=[.?!])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function dedupeSignalLines(lines: SignalLine[], limit = 3): SignalLine[] {
  const seen = new Set<string>()
  const unique: SignalLine[] = []

  for (const line of lines) {
    const key = line.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
    if (unique.length >= limit) break
  }

  return unique
}

function trimSignal(text: string, maxLength = 110): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function extractQuestions(chunks: TranscriptChunk[]): SignalLine[] {
  const lines: SignalLine[] = []

  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const lower = sentence.toLowerCase()
      if (
        sentence.includes('?') ||
        QUESTION_PREFIXES.some((prefix) => lower.startsWith(`${prefix} `)) ||
        INDIRECT_QUESTION_RE.test(lower)
      ) {
        lines.push({ timestamp: chunk.timestamp, text: trimSignal(sentence) })
      }
    }
  }

  return dedupeSignalLines(lines.reverse())
}

function extractChunkMatches(chunks: TranscriptChunk[], pattern: RegExp, limit = 3): SignalLine[] {
  const lines = chunks
    .filter((chunk) => pattern.test(chunk.text))
    .map((chunk) => ({ timestamp: chunk.timestamp, text: trimSignal(cleanText(chunk.text)) }))
    .reverse()

  return dedupeSignalLines(lines, limit)
}

function extractTopics(chunks: TranscriptChunk[], limit = 5): string[] {
  const scores = new Map<string, number>()

  chunks.forEach((chunk, chunkIndex) => {
    const weight = chunkIndex === chunks.length - 1 ? 3 : 1
    const words = cleanText(chunk.text)
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{2,}/g) ?? []

    words.forEach((word) => {
      if (STOPWORDS.has(word)) return
      scores.set(word, (scores.get(word) ?? 0) + weight)
    })
  })

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
}

export function extractConversationSignals(chunks: TranscriptChunk[]): ConversationSignals {
  return {
    topics: extractTopics(chunks),
    questions: extractQuestions(chunks),
    numericClaims: extractChunkMatches(chunks, NUMBER_PATTERN),
    commitments: extractChunkMatches(chunks, COMMITMENT_PATTERN),
    risks: extractChunkMatches(chunks, RISK_PATTERN),
    multilingualCues: extractChunkMatches(chunks, MULTILINGUAL_PATTERN, 2),
  }
}

function formatLines(title: string, lines: SignalLine[]): string {
  if (lines.length === 0) return `${title}\n- none`
  return `${title}\n${lines.map((line) => `- [${line.timestamp}] ${line.text}`).join('\n')}`
}

export function buildConversationSignalsSection(chunks: TranscriptChunk[]): string {
  if (chunks.length === 0) {
    return '## Conversation signals\n- No transcript signals yet.'
  }

  const signals = extractConversationSignals(chunks)
  const topicLine = signals.topics.length > 0
    ? `Likely live topics: ${signals.topics.join(' · ')}`
    : 'Likely live topics: none extracted yet'

  return [
    '## Conversation signals',
    topicLine,
    formatLines('Recent questions', signals.questions),
    formatLines('Claims / numbers worth checking', signals.numericClaims),
    formatLines('Commitments / next steps mentioned', signals.commitments),
    formatLines('Risks / ambiguity / blockers', signals.risks),
    formatLines('Language shifts / multilingual cues', signals.multilingualCues),
  ].join('\n\n')
}
