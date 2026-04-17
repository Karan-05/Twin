import Groq from 'groq-sdk'
import type { Message, TranscriptChunk } from './store'
import type { AppSettings } from './settings'

function buildTranscriptContext(transcript: TranscriptChunk[], maxChunks = 0): string {
  const chunks = maxChunks > 0 ? transcript.slice(-maxChunks) : transcript
  if (chunks.length === 0) return '(no transcript yet)'
  return chunks.map((c) => `[${c.timestamp}] ${c.text}`).join('\n')
}

export async function* streamChatResponse(
  messages: Message[],
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings
): AsyncGenerator<string> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const fullContext = buildTranscriptContext(transcript)
  const systemContent = settings.chatSystemPrompt.replace('{full_transcript}', fullContext)

  const stream = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemContent },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 1000,
  })

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}

export async function* streamDetailedAnswer(
  suggestionTitle: string,
  suggestionDetail: string,
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings
): AsyncGenerator<string> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const fullContext = buildTranscriptContext(transcript)

  const prompt = settings.clickDetailPrompt
    .replace('{full_transcript}', fullContext)
    .replace('{suggestion_title}', suggestionTitle)
    .replace('{suggestion_detail}', suggestionDetail)

  const stream = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    temperature: 0.7,
    max_tokens: 600,
  })

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}
