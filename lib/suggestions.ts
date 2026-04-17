import Groq from 'groq-sdk'
import { generateId, formatTimestamp } from './utils'
import { withRetry } from './retry'
import type { Suggestion, SuggestionBatch, TranscriptChunk } from './store'
import type { AppSettings } from './settings'

const STRICT_PREFIX = 'Respond ONLY with a valid JSON array. No markdown. No explanation.\n\n'

function buildPrompt(settings: AppSettings, recentChunks: TranscriptChunk[]): string {
  const recent = recentChunks.map((c) => `[${c.timestamp}] ${c.text}`).join('\n')
  return settings.liveSuggestionPrompt.replace('{recent_transcript}', recent)
}

async function fetchBatch(prompt: string, apiKey: string, strict = false): Promise<Suggestion[]> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'user',
        content: strict ? STRICT_PREFIX + prompt : prompt,
      },
    ],
    temperature: 0.7,
    max_tokens: 800,
  })

  const raw = response.choices[0]?.message?.content ?? '[]'
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(cleaned) as Array<{
    type: Suggestion['type']
    title: string
    detail: string
  }>

  return parsed.slice(0, 3).map((item) => ({
    id: generateId(),
    type: item.type,
    title: item.title,
    detail: item.detail,
  }))
}

export async function generateSuggestionBatch(
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings
): Promise<SuggestionBatch> {
  const windowSize = settings.suggestionContextWindow || 5
  const recentChunks = transcript.slice(-windowSize)
  const prompt = buildPrompt(settings, recentChunks)
  const transcriptSnapshot = recentChunks.map((c) => c.text).join(' ')

  let suggestions: Suggestion[] = []

  try {
    suggestions = await withRetry(() => fetchBatch(prompt, apiKey, false), 2, 500)
  } catch {
    suggestions = await withRetry(() => fetchBatch(prompt, apiKey, true), 2, 500)
  }

  while (suggestions.length < 3) {
    suggestions.push({
      id: generateId(),
      type: 'question',
      title: 'What else should we discuss?',
      detail: 'Consider asking the group if there are any outstanding topics to cover before moving on.',
    })
  }

  return {
    id: generateId(),
    suggestions: suggestions.slice(0, 3),
    timestamp: formatTimestamp(new Date()),
    transcriptSnapshot,
  }
}
