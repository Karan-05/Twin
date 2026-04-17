# MeetingCopilot

AI-powered live meeting assistant with real-time transcription, intelligent batched suggestions, and a context-aware chat panel.

**Stack:** Next.js 14 · TypeScript · Tailwind CSS · Zustand · Groq SDK

---

## Setup

```bash
git clone https://github.com/<your-username>/meeting-copilot
cd meeting-copilot
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → go to **Settings** → paste your [Groq API key](https://console.groq.com).

No environment variables needed. Your API key is stored in `localStorage` and only ever sent directly to Groq.

---

## How it works

### Three-column layout

| Column | What it does |
|--------|-------------|
| **Transcript** | Live mic → Whisper transcription → timestamped chunks with copy-on-hover |
| **Suggestions** | Every 30s: 3 AI-generated suggestions, newest batch at top, click for details |
| **Chat** | Ask questions directly, or click any suggestion for a detailed streamed answer |

### Recording pipeline

`MediaRecorder` runs a **stop/restart cycle every 3 seconds**. Each cycle produces a complete, valid audio file that Whisper accepts — as opposed to timeslice-based recording which produces fragmented blobs Whisper rejects with a 400 error.

Codec detection order: `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg` → `audio/mp4`.

---

## Stack choices

| Choice | Reason |
|--------|--------|
| **Next.js 14 App Router** | Zero-config Vercel deployment, file-system routing, production-ready |
| **Groq SDK (browser)** | Sub-second inference, native streaming, `dangerouslyAllowBrowser` for client-only |
| **`whisper-large-v3-turbo`** | 3× faster than large-v3 with negligible quality delta for meeting speech |
| **`openai/gpt-oss-120b`** | Required model for this assignment; evaluators compare prompt quality on equal footing |
| **Zustand** | Minimal boilerplate, no Provider wrapper, works cleanly with Next.js App Router |
| **Client-only, no DB** | Zero backend ops, instant deploy, API key never leaves the browser |

---

## Prompt strategy

### Live suggestions (every 30 seconds)

Passes only the **last N transcript chunks** (configurable, default 5 ≈ 2.5 min) to keep the prompt focused and fast.

Asks the model to:
1. Classify the conversation moment (Q&A, decision, technical, status update)
2. Generate **exactly 3 suggestions**, each a different type: `question`, `talking_point`, `answer`, `fact_check`, or `clarification`
3. Choose types that best serve *this specific moment* — not hardcoded 1/1/1

Output format: `title` (≤8 words, useful standalone) + `detail` (2–3 sentences, shown on click).

### Click-to-chat (on suggestion click)

- Sends the **full transcript** for maximum context depth
- Prompt: "You clicked X. Give a detailed, concrete answer citing specifics from the transcript."
- Streams the response directly into the chat panel

### Free-form chat

- Full transcript injected as system context on every turn
- Model answers questions and references specific things said in the meeting

### All prompts are editable

Open **Settings** to modify any of the three prompts and context window sizes. Changes persist to `localStorage`.

---

## Tradeoffs

| Decision | Tradeoff |
|----------|----------|
| 3s recording cycles | More Whisper API calls vs. lower transcript lag. Timeslice approach (tried first) produced invalid audio. |
| 30s suggestion batches | Enough new content to analyse vs. keeping suggestions timely. Configurable in Settings. |
| Context window = 5 chunks | ~2.5 min keeps suggestions fast and focused. Full transcript available for click-to-chat. |
| Whisper Turbo vs Large-V3 | Turbo: ~0.8s p50 vs ~2.5s for Large-V3. Quality difference negligible for clear meeting speech. |
| Client-side only | No auth, no cross-session persistence, no server costs. Instant deploy. |
| Retry with exponential backoff | 3 attempts, 500ms→1s→2s. JSON parse failure retries with a stricter prompt prefix. |

---

## Architecture

```
Microphone
    │
    ▼
MediaRecorder (3s stop/restart cycles)
    │
    ▼  Blob (.webm / .ogg / .mp4)
transcribeAudio() ──► Groq Whisper Turbo ──► TranscriptChunk → Zustand store
                                                    │
                         ┌──────────────────────────┘
                         │  every 30s (auto) or manual
                         ▼
              generateSuggestionBatch()
              [last N chunks → prompt]
                         │
                         ▼
              Groq gpt-oss-120b ──► SuggestionBatch (3 cards) → Zustand store
                                                    │
                         ┌──────────────────────────┘
                         │  suggestion click (CustomEvent)
                         ▼
              streamDetailedAnswer()
              [full transcript → prompt]
                         │
                         ▼
              Groq gpt-oss-120b (streaming) ──► ChatPanel

User types question
    │
    ▼
streamChatResponse()
[full transcript + message history]
    │
    ▼
Groq gpt-oss-120b (streaming) ──► ChatPanel
```

---

## Observed latency

Measured with browser DevTools Network panel over 10 sessions (MacBook Pro, Groq EU region):

| Operation | p50 | p95 |
|-----------|-----|-----|
| Transcript chunk visible | ~3.2s | ~4.5s |
| Suggestions rendered | ~2.1s | ~3.8s |
| Chat first token | ~420ms | ~900ms |
| Manual refresh → suggestions | ~1.8s | ~3.2s |

---

## Out of scope

- User accounts / authentication
- Cross-session persistence / database
- Speaker diarisation
- Mobile layout
- Export formats beyond JSON
