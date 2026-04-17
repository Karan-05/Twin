import Groq from 'groq-sdk'

const EXT_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/webm;codecs=opus': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg;codecs=opus': 'ogg',
  'audio/mp4': 'mp4',
}

export async function transcribeAudio(
  blob: Blob,
  apiKey: string,
  mimeType?: string
): Promise<string> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const mime = mimeType || blob.type || 'audio/webm'
  const baseMime = mime.split(';')[0]
  const ext = EXT_MAP[baseMime] ?? EXT_MAP[mime] ?? 'webm'
  const file = new File([blob], `audio.${ext}`, { type: baseMime })
  const response = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    response_format: 'json',
    language: 'en',
  })
  return response.text
}
