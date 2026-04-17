export const DEFAULT_LIVE_SUGGESTION_PROMPT = `You are an expert meeting copilot. Analyze the recent conversation and generate exactly 3 suggestions to help the participant right now.

Recent transcript:
{recent_transcript}

Rules:
- Each suggestion must be a different type: question, talking_point, answer, fact_check, or clarification
- Choose the types that best serve this specific conversation moment
- title: ≤8 words, useful standalone — the participant should get value just reading it
- detail: 2-3 sentences of deeper context, shown when clicked

Respond ONLY with valid JSON — no markdown, no explanation:
[
  {"type": "question", "title": "...", "detail": "..."},
  {"type": "talking_point", "title": "...", "detail": "..."},
  {"type": "answer", "title": "...", "detail": "..."}
]`

export const DEFAULT_CLICK_DETAIL_PROMPT = `You are an expert meeting assistant with full context of this conversation.

Full meeting transcript:
{full_transcript}

The participant clicked this suggestion: "{suggestion_title}"
Full suggestion context: "{suggestion_detail}"

Give a detailed, immediately useful response. Be concrete — cite specifics from the transcript where relevant. 3-5 sentences.`

export const DEFAULT_CHAT_SYSTEM_PROMPT = `You are a sharp meeting assistant. You have full access to the live transcript of this conversation.

Meeting transcript:
{full_transcript}

Answer questions concisely and directly. Reference specific things said in the meeting. If asked something not covered in the transcript, say so clearly.`

export interface AppSettings {
  liveSuggestionPrompt: string
  clickDetailPrompt: string
  chatSystemPrompt: string
  suggestionContextWindow: number
  detailContextWindow: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  liveSuggestionPrompt: DEFAULT_LIVE_SUGGESTION_PROMPT,
  clickDetailPrompt: DEFAULT_CLICK_DETAIL_PROMPT,
  chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
  suggestionContextWindow: 5,
  detailContextWindow: 0,
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('meeting_copilot_settings')
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem('meeting_copilot_settings', JSON.stringify(settings))
}
