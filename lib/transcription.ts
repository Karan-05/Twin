import Groq from 'groq-sdk'

const EXT_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/webm;codecs=opus': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg;codecs=opus': 'ogg',
  'audio/mp4': 'mp4',
}

// Prompt must look like example transcript output — NOT instructions.
// Whisper conditions on the prompt text; any imperative phrase ("Transcribe…") gets
// repeated verbatim when audio confidence is low. Natural conversation openers are safe.
// Passing the previous transcript chunk here gives Whisper continuity context —
// it recognises proper nouns, product names, and speaker vocabulary from earlier chunks.
const LANGUAGE_PROMPTS: Record<string, string> = {
  en: 'Okay, so moving on. The next item on the agenda is',
  hi: 'ठीक है, तो शुरू करते हैं। अगला विषय है',
  es: 'Bien, continuemos. El siguiente punto del orden del día es',
  fr: "Très bien, continuons. Le point suivant à l'ordre du jour est",
  de: 'Gut, dann weiter. Der nächste Punkt auf der Tagesordnung ist',
  pt: 'Certo, vamos continuar. O próximo item da pauta é',
  it: 'Bene, andiamo avanti. Il prossimo punto all\'ordine del giorno è',
  ja: 'では、次の議題に移りましょう。',
  zh: '好的，我们继续。下一个议题是',
  ar: 'حسنًا، لنستمر. البند التالي في جدول الأعمال هو',
}

// Whisper prompt has a ~224-token limit. Keep the opener short and trim prior context
// to leave room for both. 80 words is language-agnostic and safe for CJK/Arabic where
// 500 chars would overflow the token budget (500 CJK chars ≈ 500 tokens).
const MAX_PRIOR_CONTEXT_WORDS = 80

// Known Whisper hallucination artifacts — YouTube training data pollution,
// our own prompt leaking back when audio confidence is near zero, and
// common filler outputs Whisper generates for near-silence.
const HALLUCINATION_PATTERNS = [
  /transcribe proper nouns/i,
  /transcription by castingwords/i,
  /thank you for watching/i,
  /altyaz[ıi]/i,
  /^\s*\.{2,}\s*$/,
  /^\s*(uh+|um+|hmm+|ah+)\s*\.?\s*$/i,
  /^you\s*can\s*find\s*(more|us|it)/i,
  /^subscribe\s*(to|for)\s*(more|our)/i,
  /like\s*and\s*subscribe/i,
  /^\s*\[?(music|applause|laughter|silence|noise|inaudible)\]?\s*$/i,
]

export function isHallucination(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return HALLUCINATION_PATTERNS.some((p) => p.test(t))
}

export async function transcribeAudio(
  blob: Blob,
  apiKey: string,
  mimeType?: string,
  language?: string,
  priorTranscriptText?: string
): Promise<string> {
  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const mime = mimeType || blob.type || 'audio/webm'
  const baseMime = mime.split(';')[0]
  const ext = EXT_MAP[baseMime] ?? EXT_MAP[mime] ?? 'webm'
  const file = new File([blob], `audio.${ext}`, { type: baseMime })

  // Build the Whisper prompt from the language opener + tail of the previous chunk.
  // Whisper conditions on this text: including recent spoken vocabulary (product names,
  // proper nouns, acronyms) improves continuity accuracy across 30s chunk boundaries.
  const opener = LANGUAGE_PROMPTS[language ?? ''] ?? LANGUAGE_PROMPTS['en']
  const priorContext = priorTranscriptText
    ? priorTranscriptText.trim().split(/\s+/).slice(-MAX_PRIOR_CONTEXT_WORDS).join(' ').slice(-200)
    : ''
  const prompt = priorContext ? `${opener} ${priorContext}` : opener

  const response = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    response_format: 'json',
    temperature: 0,
    ...(language ? { language } : {}),
    prompt,
  })
  return response.text
}
