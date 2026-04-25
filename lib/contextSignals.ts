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

export type QuestionCategory =
  | 'definition'
  | 'mechanism'
  | 'comparison'
  | 'reason'
  | 'tradeoff'
  | 'implementation'
  | 'location'
  | 'person'
  | 'timing'
  | 'general'

export type QuestionIntent =
  | 'meeting_coaching'
  | 'direct_answer'
  | 'general_knowledge'
  | 'domain_knowledge'
  | 'technical_knowledge'

interface QuestionCandidate extends SignalLine {
  resolvedInChunk: boolean
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
  'can', 'cant', 'cannot', 'not', 'yes', 'yeah', 'okay', 'well', 'right', 'maybe', 'how', 'any', 'into', 'over',
  'under', 'than', 'after', 'before', 'because', 'through', 'across', 'around', 'meeting', 'call',
  // adjectives, adverbs, common verbs that pollute topic extraction in sales/marketing speech
  'real', 'time', 'new', 'always', 'never', 'every', 'human', 'based', 'available', 'working',
  'provide', 'provided', 'provides', 'tell', 'told', 'here', 'come', 'coming', 'give', 'given',
  'look', 'looking', 'goes', 'going', 'gets', 'getting', 'take', 'taking', 'keep', 'keeping',
  'actual', 'entire', 'general', 'certain', 'specific', 'different', 'important', 'possible',
  'large', 'small', 'long', 'short', 'high', 'able', 'using', 'used', 'use', 'work', 'works',
  'good', 'great', 'best', 'better', 'right', 'wrong', 'help', 'helps', 'helped',
  'thank', 'thanks',
])

const LOW_VALUE_TOPIC_WORDS = new Set([
  'latest', 'topic', 'topics', 'conversation', 'conversations', 'discussion', 'discuss',
  'existence', 'everything', 'something', 'stuff', 'things', 'awesome', 'important',
  'process', 'system', 'architecture',
])

const KNOWN_TECH_TERMS: Array<[RegExp, string]> = [
  [/\bvoice ai agents?\b/i, 'Voice AI agents'],
  [/\bvoice agents?\b/i, 'voice agents'],
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

const LOW_SIGNAL_CHECKIN_PATTERN = /\b(would you like to know more|does that make sense|how does that sound|sound good|would that help|would that be useful|what do you think about that|is that something you'd want)\b/i
const LOW_SIGNAL_SOCIAL_PATTERN = /\b(how are you|how's it going|what's up|where are you (?:living|staying|based|located)|where do you live|brother|thank you)\b/i
const PROBING_PROMPT_PATTERN = /^(?:(?:can|could)\s+you\s+share\b.*\b(?:how many|which|what|who)\b|would you like\b|do you want\b|how would you want\b|what would you like\b|anything special\b|is there anything\b|can we\b|should we\b|which matters most\b|what matters most\b)/i
const EXPERIENCE_QUESTION_PATTERN = /\b(?:tell me about|walk me through|can you share|could you share|describe)\b.*\b(?:a time|an example|experience|project|situation|instance|decision|conflict|challenge|failure|mistake)\b/i
const ANSWERISH_SENTENCE_PATTERN = /^(?:yes|yeah|yep|no|nope|i\b|we\b|they\b|about\b|around\b|roughly\b|approximately\b|tens?\b|a few\b|not really\b|i don't think so\b|that works\b|sounds good\b|fine\b|okay\b)/i
const DEEP_TECH_SIGNAL_PATTERN = /\b(tokenization|tokenisation|embedding|embeddings|transformer|attention|next token|inference|latency|throughput|architecture|pipeline|security|api|integration|model|scal(?:e|ing)|hallucinat)\b/i
const SHALLOW_TECH_PATTERN = /\bhow (does|do|can|to)\b.*\b(work|works|system|platform|agent|pipeline|integration|architecture|api|security|model)\b/i
const DIRECT_KNOWLEDGE_PATTERN = /\b(what is|what's|where is|where are|who is|who are|when is|when did|why does|why do|how does|how do|how can|how to|define|explain|tell me about|walk me through|difference between|compare|versus|vs|meaning of)\b/i
const MEETING_CONTROL_PATTERN = /\b(who owns|owner|by when|next step|before we wrap|can you be more specific|what should we do|should we|do we want to|what do you think|what would make|how should we think about|would you like to know more|does that make sense|sound good|what workflow matters|who else will weigh in)\b/i
const DOMAIN_KNOWLEDGE_PATTERN = /\b(what kind of|what does .* do|who is .* for|how is .* used|use case|workflow|configuration|configurations|pricing|plan|tier|sku|edition|package|feature set|capabilities|model|ram|storage|gpu|specs?|delivery|shipping|lead time|customization|software)\b/i
const PARTICIPANT_ANSWER_PATTERN = /\b(can you|could you|would you|why did you|how did you|what did you|where did you|when did you|who did you)\b/i
const SHORT_BINARY_CHECK_PATTERN = /^(?:is it|is that|are they|are there)\b/i

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripQuestionLeadIn(text: string): string {
  return cleanText(text).replace(/^(?:(?:so|hey|well|um|uh|and|but|also|okay|right|yeah|now|like|alright|actually|basically)\s+){1,3}/i, '').trim()
}

function isLowSignalSocialText(text: string): boolean {
  return LOW_SIGNAL_SOCIAL_PATTERN.test(text.toLowerCase())
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

function extractQuestionCandidates(chunks: TranscriptChunk[]): QuestionCandidate[] {
  const lines: QuestionCandidate[] = []

  for (const chunk of chunks) {
    const sentences = splitSentences(chunk.text)
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index]
      const lower = sentence.toLowerCase()
      if (
        sentence.includes('?') ||
        QUESTION_PREFIXES.some((prefix) => lower.startsWith(`${prefix} `)) ||
        INDIRECT_QUESTION_RE.test(lower)
      ) {
        const nextSentence = sentences[index + 1] ?? ''
        const normalized = stripQuestionLeadIn(sentence)
        lines.push({
          timestamp: chunk.timestamp,
          text: trimSignal(normalized || sentence),
          resolvedInChunk: ANSWERISH_SENTENCE_PATTERN.test(stripQuestionLeadIn(nextSentence)),
        })
      }
    }
  }

  return dedupeSignalLines(lines.reverse(), 6) as QuestionCandidate[]
}

function extractQuestions(chunks: TranscriptChunk[]): SignalLine[] {
  return extractQuestionCandidates(chunks).map(({ timestamp, text }) => ({ timestamp, text }))
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
    if (isLowSignalSocialText(chunk.text)) return
    const weight = chunkIndex === chunks.length - 1 ? 2 : 1
    const words = cleanText(chunk.text)
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{2,}/g) ?? []

    words.forEach((word) => {
      if (STOPWORDS.has(word)) return
      if (LOW_VALUE_TOPIC_WORDS.has(word)) return
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
  const questionTexts = extractQuestions(chunks)
    .map((line) => line.text)
    .filter((line) => !isLowSignalSocialText(line))
  const transcriptSources = chunks
    .map((chunk) => chunk.text)
    .filter((text) => !isLowSignalSocialText(text))
  const prioritizedSources = [hint, ...questionTexts].filter(Boolean)
  const fallbackSources = transcriptSources

  for (const source of prioritizedSources) {
    for (const [pattern, canonical] of KNOWN_TECH_TERMS) {
      if (pattern.test(source)) return canonical
    }
  }

  for (const source of prioritizedSources) {
    const acronyms = source.match(/\b[A-Z]{2,}(?:[-/][A-Z0-9]{2,})?\b/g) ?? []
    const usefulAcronym = acronyms.find((token) => !LOW_VALUE_TOPIC_WORDS.has(token.toLowerCase()))
    if (usefulAcronym) return usefulAcronym
  }

  for (const source of [...prioritizedSources, ...fallbackSources]) {
    for (const pattern of QUESTION_TOPIC_PATTERNS) {
      const match = source.match(pattern)
      const normalized = match?.[1] ? normalizeTopicCandidate(match[1]) : null
      if (normalized) return normalized
    }
  }

  for (const source of fallbackSources) {
    for (const [pattern, canonical] of KNOWN_TECH_TERMS) {
      if (pattern.test(source)) return canonical
    }

    const acronyms = source.match(/\b[A-Z]{2,}(?:[-/][A-Z0-9]{2,})?\b/g) ?? []
    const usefulAcronym = acronyms.find((token) => !LOW_VALUE_TOPIC_WORDS.has(token.toLowerCase()))
    if (usefulAcronym) return usefulAcronym
  }

  const extractedTopics = extractTopics(chunks)
  const usefulTopic = extractedTopics.find((topic) => !LOW_VALUE_TOPIC_WORDS.has(topic.toLowerCase()))
  return usefulTopic ?? null
}

export function selectActionableQuestion(
  chunks: TranscriptChunk[],
  context?: { meetingType?: string; userRole?: string }
): SignalLine | null {
  const questions = extractQuestionCandidates(chunks)
  if (questions.length === 0) return null
  const scored = questions
    .map((line, index) => {
      const normalized = stripQuestionLeadIn(line.text)
      const lower = normalized.toLowerCase()
      const category = inferQuestionCategory(normalized)
      const intent = inferQuestionIntent(normalized, context)
      let score = 0

      if (!line.resolvedInChunk) score += 4
      else score -= 2

      score += Math.max(0, questions.length - index) * 0.45

      if (isLowSignalSocialText(normalized)) score -= 8
      if (LOW_SIGNAL_CHECKIN_PATTERN.test(lower)) score -= 5
      if (intent === 'meeting_coaching') score -= 2.5
      else score += 2

      if (EXPERIENCE_QUESTION_PATTERN.test(lower)) score += 2
      if (DIRECT_KNOWLEDGE_PATTERN.test(lower)) score += 1.5
      if (category !== 'general') score += 1
      if (SHORT_BINARY_CHECK_PATTERN.test(lower) && normalized.length <= 28 && category === 'general') score -= 1.5

      return { line, score }
    })
    .sort((left, right) => right.score - left.score)

  return scored[0]?.line ?? null
}

export function isTechnicalQuestion(
  text: string,
  context?: { meetingType?: string; userRole?: string }
): boolean {
  return inferQuestionIntent(text, context) === 'technical_knowledge'
}

export function inferQuestionCategory(text: string): QuestionCategory {
  const lower = stripQuestionLeadIn(text).toLowerCase()
  if (/\bwhere is\b|\bwhere are\b|\blocated\b|\blocation\b/.test(lower)) return 'location'
  if (/\bwho is\b|\bwho are\b|\bwhose\b/.test(lower)) return 'person'
  if (/^when\b|\bwhen is\b|\bwhen did\b|\bwhat year\b|\bwhat time\b|\bwhen does\b|\bwhen can\b|\bwhen will\b|\bwhen should\b/.test(lower)) return 'timing'
  if (/\bwhat is\b|\bwhat's\b|\bdefine\b|\bmeaning of\b/.test(lower)) return 'definition'
  if (/\bhow does\b|\bhow do\b|\bhow can\b|\bhow to\b|\bworks?\b/.test(lower)) return 'mechanism'
  if (/\bcompare\b|\bversus\b|\bvs\b|\bdifference\b|\bbetter than\b/.test(lower)) return 'comparison'
  if (/\bwhy\b|\bimportance\b|\bmatter\b/.test(lower)) return 'reason'
  if (/\btradeoff\b|\btrade-off\b|\bpros and cons\b|\bdownside\b|\bupside\b/.test(lower)) return 'tradeoff'
  if (/\bimplement\b|\bintegration\b|\brollout\b|\bonboarding\b|\bfirst two weeks\b/.test(lower)) return 'implementation'
  return 'general'
}

export function inferQuestionIntent(
  text: string,
  context?: { meetingType?: string; userRole?: string }
): QuestionIntent {
  const lower = stripQuestionLeadIn(text).toLowerCase()

  if (LOW_SIGNAL_CHECKIN_PATTERN.test(lower)) return 'meeting_coaching'
  if (LOW_SIGNAL_SOCIAL_PATTERN.test(lower)) return 'meeting_coaching'
  if (MEETING_CONTROL_PATTERN.test(lower)) return 'meeting_coaching'
  if (PROBING_PROMPT_PATTERN.test(lower) && !EXPERIENCE_QUESTION_PATTERN.test(lower)) return 'meeting_coaching'
  if (EXPERIENCE_QUESTION_PATTERN.test(lower)) return 'direct_answer'

  if (DOMAIN_KNOWLEDGE_PATTERN.test(lower) && !DEEP_TECH_SIGNAL_PATTERN.test(lower) && !PARTICIPANT_ANSWER_PATTERN.test(lower)) {
    return 'domain_knowledge'
  }

  if (DEEP_TECH_SIGNAL_PATTERN.test(lower) || SHALLOW_TECH_PATTERN.test(lower)) {
    return 'technical_knowledge'
  }

  if (DIRECT_KNOWLEDGE_PATTERN.test(lower)) return 'general_knowledge'

  if (QUESTION_PREFIXES.some((prefix) => lower.startsWith(`${prefix} `))) {
    if (PARTICIPANT_ANSWER_PATTERN.test(lower) || /\byou\b|\byour\b/.test(lower)) return 'direct_answer'
    return 'general_knowledge'
  }

  void context
  return 'meeting_coaching'
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
