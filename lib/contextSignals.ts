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
// Requires either a currency prefix OR a meaningful unit — bare numbers like "24 7" (24/7) don't qualify
const NUMBER_PATTERN = /(?:(?:\$|€|£|¥)\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:%|percent|x\b|million|billion|k\b|m\b|b\b|days?|weeks?|months?|years?|hrs?|hours?|minutes?|seconds?|ms\b))\b/i
const MULTILINGUAL_PATTERN = /[^\x00-\x7F]|\b(sí|si|porque|equipo|operaciones|trimestre|gracias|hola|vale|pero|también|tambien|necesita|necesitamos|migraci[oó]n|largo|larga)\b/i

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'they', 'them', 'their', 'there', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'when', 'what', 'where', 'while', 'which',
  'who', 'your', 'you', 'our', 'ours', 'we', 'us', 'for', 'are', 'was', 'were', 'been', 'being',
  'will', 'just', 'said', 'says', 'also', 'only', 'really', 'very', 'more', 'most', 'much', 'many',
  'some', 'like', 'kind', 'sort', 'need', 'want', 'make', 'made', 'does', 'doing', 'did', 'done',
  'can', 'cant', 'cannot', 'not', 'yes', 'yeah', 'okay', 'well', 'right', 'maybe', 'into', 'over',
  'under', 'than', 'after', 'before', 'because', 'through', 'across', 'around', 'meeting', 'call',
  // adjectives, adverbs, common verbs that pollute topic extraction in sales/marketing speech
  'real', 'time', 'new', 'always', 'never', 'every', 'human', 'based', 'available', 'working',
  'provide', 'provided', 'provides', 'tell', 'told', 'here', 'come', 'coming', 'give', 'given',
  'look', 'looking', 'goes', 'going', 'gets', 'getting', 'take', 'taking', 'keep', 'keeping',
  'actual', 'entire', 'general', 'certain', 'specific', 'different', 'important', 'possible',
  'large', 'small', 'long', 'short', 'high', 'able', 'using', 'used', 'use', 'work', 'works',
  'good', 'great', 'best', 'better', 'right', 'wrong', 'help', 'helps', 'helped',
])

const LOW_VALUE_TOPIC_WORDS = new Set([
  'latest', 'topic', 'topics', 'conversation', 'conversations', 'discussion', 'discuss',
  'existence', 'everything', 'something', 'stuff', 'things', 'awesome', 'important',
  'process', 'system', 'architecture',
])

const KNOWN_TECH_TERMS: Array<[RegExp, string]> = [
  [/\bllms?\b/i, 'LLM'],
  [/\blarge language models?\b/i, 'LLM'],
  [/\brag\b/i, 'RAG'],
  [/\bgpt(?:-[a-z0-9.]+)?\b/i, 'GPT'],
  [/\bapi(?:s)?\b/i, 'API'],
  [/\basr\b/i, 'ASR'],
  [/\btts\b/i, 'TTS'],
  [/\boauth\b/i, 'OAuth'],
  [/\bsql\b/i, 'SQL'],
  [/\bocr\b/i, 'OCR'],
]

const QUESTION_TOPIC_PATTERNS = [
  /\bhow\s+(.+?)\s+works?\b/i,
  /\b(?:what is|what's|how does|how do|explain|walk me through|tell me about|talk about|discuss(?:ing)?)\s+(.+?)(?:[?.,]|$)/i,
]

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
    const weight = chunkIndex === chunks.length - 1 ? 2 : 1
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

function normalizeTopicCandidate(raw: string): string | null {
  const cleaned = raw
    .replace(/^["'`(\[]+|["'`)\]]+$/g, '')
    .replace(/^(how|what|why|when|where|who|which|tell|explain|walk)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return null

  const parts = cleaned.split(' ')
    .filter((word) => !/^(a|an|the|this|that|these|those|latest|important|actual)$/i.test(word))
    .filter((word) => !/^(work|works|working|process|processes|topic|topics|conversation|discussion)$/i.test(word))

  if (parts.length === 0) return null

  const verbIndex = parts.findIndex((word, index) =>
    index > 0 && /^(handle|handles|handled|using|uses|use|works|work|working|scales|scale|scaled|runs|run|running|does|do|can|should|would|could|responds|respond|processes|process)$/i.test(word)
  )
  const trimmedParts = verbIndex > 0 ? parts.slice(0, verbIndex) : parts

  while (trimmedParts.length > 0 && /^(and|or|with|about|like)$/i.test(trimmedParts[trimmedParts.length - 1])) {
    trimmedParts.pop()
  }

  const candidate = trimmedParts.slice(0, 4).join(' ').trim()
  if (!candidate) return null
  if (LOW_VALUE_TOPIC_WORDS.has(candidate.toLowerCase())) return null
  return candidate
}

export function extractPrimaryTopic(chunks: TranscriptChunk[], hint = ''): string | null {
  const questionTexts = extractQuestions(chunks).map((line) => line.text)
  const sources = [hint, ...questionTexts, ...chunks.map((chunk) => chunk.text)].filter(Boolean)

  for (const source of sources) {
    for (const [pattern, canonical] of KNOWN_TECH_TERMS) {
      if (pattern.test(source)) return canonical
    }

    const acronyms = source.match(/\b[A-Z]{2,}(?:[-/][A-Z0-9]{2,})?\b/g) ?? []
    const usefulAcronym = acronyms.find((token) => !LOW_VALUE_TOPIC_WORDS.has(token.toLowerCase()))
    if (usefulAcronym) return usefulAcronym
  }

  for (const source of sources) {
    for (const pattern of QUESTION_TOPIC_PATTERNS) {
      const match = source.match(pattern)
      const normalized = match?.[1] ? normalizeTopicCandidate(match[1]) : null
      if (normalized) return normalized
    }
  }

  const extractedTopics = extractTopics(chunks)
  const usefulTopic = extractedTopics.find((topic) => !LOW_VALUE_TOPIC_WORDS.has(topic.toLowerCase()))
  return usefulTopic ?? null
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
