import type { Sentiment } from './store'

const POSITIVE_PATTERN = /\b(good|great|sounds good|love|perfect|awesome|excellent|works|agreed|agree|yes, let'?s|happy|solid)\b/i
const TENSE_PATTERN = /\b(blocked|blocker|concern|risk|issue|problem|pushback|hard|difficult|won't|cannot|can'?t|delay|slip|objection|stall)\b/i
const CONFUSED_PATTERN = /\b(not sure|unsure|unclear|maybe|depends|what if|how do we|why do we|who owns|does anyone know|i think|i guess|question)\b/i

function classifySentiment(text: string): Sentiment {
  if (TENSE_PATTERN.test(text)) return 'tense'
  if (CONFUSED_PATTERN.test(text) || text.includes('?')) return 'confused'
  if (POSITIVE_PATTERN.test(text)) return 'positive'
  return 'neutral'
}

export async function classifySentimentBatch(
  items: { id: string; text: string }[],
  apiKey: string
): Promise<Array<{ id: string; sentiment: Sentiment }>> {
  void apiKey
  if (items.length === 0) return []

  return items.map((item) => ({
    id: item.id,
    sentiment: classifySentiment(item.text),
  }))
}
