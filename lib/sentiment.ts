import Groq from 'groq-sdk'
import type { Sentiment } from './store'

const VALID_SENTIMENTS = new Set<Sentiment>(['positive', 'neutral', 'tense', 'confused'])

export async function classifySentimentBatch(
  items: { id: string; text: string }[],
  apiKey: string
): Promise<Array<{ id: string; sentiment: Sentiment }>> {
  if (items.length === 0) return []

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  const prompt =
    `Classify the sentiment of each meeting statement. ` +
    `Use exactly one label per item: positive (agreement, good news, enthusiasm), ` +
    `neutral (factual, procedural), tense (disagreement, pushback, concern), ` +
    `confused (uncertainty, questions, unclear).\n\n` +
    `Statements:\n` +
    items.map((it) => `{"id":"${it.id}","text":${JSON.stringify(it.text)}}`).join('\n') +
    `\n\nRespond ONLY with a JSON array: [{"id":"...","sentiment":"..."},...]`

  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 300,
  })

  const raw = response.choices[0]?.message?.content ?? '[]'
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  const jsonStr = start !== -1 && end !== -1 ? cleaned.slice(start, end + 1) : cleaned

  const parsed = JSON.parse(jsonStr) as Array<{ id: string; sentiment: string }>
  return parsed.map((p) => ({
    id: p.id,
    sentiment: VALID_SENTIMENTS.has(p.sentiment as Sentiment)
      ? (p.sentiment as Sentiment)
      : 'neutral',
  }))
}
