# Meeting Copilot — Full Production Spec

**Date:** 2026-04-16  
**Status:** Approved  
**Assignment:** TwinMind Live Suggestions — evaluated on prompt quality, full-stack engineering, latency, code quality  
**Scope:** Complete rebuild of UI, suggestion pipeline, prompt engineering, settings, and Vercel deployment

---

## 0. Assignment Checklist (what gets evaluated)

| Criterion | Priority | Our approach |
|---|---|---|
| Quality of live suggestions | #1 | Smart prompt with context classification, 3 varied types per batch |
| Quality of click-to-chat answers | #2 | Separate long-form prompt with full transcript context |
| Prompt engineering | #3 | Rolling window, context-aware type selection, structured output |
| Full-stack engineering | #4 | Clean pipeline, error handling, retry logic, streaming |
| Code quality | #5 | Typed interfaces, small focused modules, no dead code |
| Latency | #6 | 3s transcript cycles, <3s suggestion render, <500ms chat first token |
| Overall experience | #7 | Responsive, trustworthy, recovers gracefully from failures |

---

## 1. Critical Fixes (blockers before anything else)

### 1a. Model
- **Transcription:** `whisper-large-v3` (correct — keep)
- **Suggestions + Chat:** `openai/gpt-oss-120b` (replace current `llama-4-scout`)
- Reason: assignment mandates this model so evaluators compare prompt quality on equal footing

### 1b. Suggestion Batching
- Each refresh produces **exactly 3 suggestions** as a single batch
- New batch appears at **top** of the suggestions column
- Previous batches remain visible **below** (accordion or stacked)
- Each suggestion card has a short **preview** (useful standalone) + click reveals full detail in chat
- Clicking a card = sends it as a chat message + triggers a detailed answer

### 1c. Click-to-Chat
- Clicking a suggestion:
  1. Adds the suggestion as a user message in the chat panel
  2. Triggers a separate **detailed-answer prompt** (longer-form, full transcript context)
  3. Streams the response into the chat
- Users can also type questions directly (existing behavior — keep)

### 1d. Settings Page — Required Fields
Beyond the API key, the settings page must expose:
- Live suggestion prompt (textarea, default pre-filled)
- Click-to-chat detailed answer prompt (textarea)
- Chat system prompt (textarea)  
- Suggestion context window (number of recent transcript segments, default: 5)
- Detailed answer context window (number of segments, default: full transcript)
- All persisted to `localStorage`

---

## 2. Suggestion Pipeline Architecture

### Trigger Conditions
- **Auto:** every 30 seconds while recording (countdown visible in header)
- **Manual:** "↻ Refresh" button — immediately fetches new batch regardless of timer
- **On suggestion click:** triggers detailed-answer chat response (not a new suggestion batch)

### Context Window Strategy
```
Recent context  = last N transcript chunks (configurable, default 5 = ~2.5 min)
Full context    = entire session transcript (used for click-to-chat detailed answers)
```
Sending only recent context keeps suggestion prompts focused and fast. Full context is used only for detailed answers where depth matters.

### Suggestion Prompt Strategy
The live suggestion prompt is the core of the product. It must:

1. **Classify the conversation moment** — is it a Q&A, a decision point, a technical discussion, a status update?
2. **Generate exactly 3 suggestions**, each a different type drawn from:
   - `question` — a sharp question the user could ask right now
   - `talking_point` — a relevant fact, data point, or perspective to contribute
   - `answer` — an answer to a question that was just asked in the meeting
   - `fact_check` — verification or pushback on a claim just made
   - `clarification` — something that should be defined or clarified before moving on
3. Each suggestion: `title` (≤8 words, the preview card text) + `detail` (2–3 sentences, used in chat)
4. The **mix of types** should reflect what the conversation actually needs — not hardcoded 1/1/1

### Live Suggestion Prompt (default, editable in settings)
```
You are an expert meeting copilot. Analyze the recent conversation and generate exactly 3 suggestions to help the participant right now.

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
]
```

### Click-to-Chat Prompt (default, editable in settings)
```
You are an expert meeting assistant with full context of this conversation.

Full meeting transcript:
{full_transcript}

The participant clicked this suggestion: "{suggestion_title}"
Full suggestion context: "{suggestion_detail}"

Give a detailed, immediately useful response. Be concrete — cite specifics from the transcript where relevant. 3-5 sentences.
```

### Chat System Prompt (default, editable in settings)
```
You are a sharp meeting assistant. You have full access to the live transcript of this conversation.

Meeting transcript:
{full_transcript}

Answer questions concisely and directly. Reference specific things said in the meeting. If asked something not covered in the transcript, say so clearly.
```

---

## 3. Audio + Transcript Pipeline

### Recording Strategy
- `MediaRecorder` stop/restart cycle every **3 seconds** → sends complete valid audio file to Whisper
- Each cycle: detect best supported codec (`audio/webm;codecs=opus` → `audio/webm` → `audio/ogg` → `audio/mp4`)
- Transcription model: `whisper-large-v3-turbo` (3× faster than large-v3, negligible quality delta for meeting speech)
- Silent chunk detection: skip API call if blob < 1000 bytes

### Transcript Display
- Each returned text appended as a timestamped chunk
- Auto-scroll to bottom
- Copy-on-hover per chunk
- Chunks accumulate in Zustand store for the full session

### Suggestion Auto-Trigger
- 30-second countdown timer tracked in store (`nextSuggestionIn: number`)
- Visible in the suggestions column header: "Next refresh in 0:28"
- Resets on manual refresh
- Only fires if transcript has content

---

## 4. Robustness & Error Handling

### Retry Logic
- All Groq API calls wrapped in a retry utility: 3 attempts, exponential backoff (500ms → 1s → 2s)
- On final failure: show inline error with "Retry" button — never silently discard

### Audio Failures
- If `getUserMedia` denied: show clear inline error with instructions, stop recording state
- If a transcription call fails: log the failed chunk, show transient error toast, continue recording
- Dropped chunks do not break the session — partial transcript is acceptable

### Suggestion Failures
- If JSON parse fails: retry the API call once with a stricter prompt prefix
- If API returns fewer than 3 suggestions: pad with a generic fallback or show partial batch
- Never crash the panel — always render what we have

### Chat Failures
- If stream breaks mid-response: show "(response interrupted)" + a "Retry" button
- Preserve the partial streamed content

### State Consistency
- `isRecording` flag in Zustand is the single source of truth — all panels derive from it
- `isGeneratingSuggestions` and `isStreamingChat` are separate flags to avoid UI conflicts

---

## 5. Latency Targets

| Operation | Target p50 | Target p95 | How we hit it |
|---|---|---|---|
| Transcript chunk visible | < 3.5s | < 5s | 3s recording cycle + Whisper Turbo |
| Suggestions rendered | < 3s | < 5s | Single API call, small context window |
| Chat first token | < 600ms | < 1.2s | Groq streaming, immediate render on first delta |
| Manual refresh to suggestions | < 2.5s | < 4s | No debounce on manual trigger |

### What we measure in the README
- We will document observed p50/p95 for each operation
- Whisper Turbo vs Large-V3 latency comparison
- Effect of context window size on suggestion quality vs latency

---

## 6. Design System — Pure White + Lime Carbon

*(from approved mockup — full token table in Section 6a)*

### 6a. Color Tokens

| Token | Value | Usage |
|---|---|---|
| `bg-primary` | `#ffffff` | App background |
| `bg-secondary` | `#f9fafb` | Column headers, panels |
| `bg-tertiary` | `#f3f4f6` | Cards, inputs |
| `border` | `#f0f0f0` | All dividers |
| `border-strong` | `#e5e7eb` | Card outlines, nav |
| `accent` | `#84cc16` | CTA, waveform, user bubbles |
| `accent-dark` | `#65a30d` | Hover states, titles |
| `accent-hover` | `#78b813` | Button hover |
| `accent-bg` | `#f7fee7` | Suggestion card backgrounds |
| `accent-mid` | `#ecfccb` | Hover tints |
| `accent-border` | `#d9f99d` | Accent-adjacent borders |
| `on-accent` | `#1a2e05` | Text on lime |
| `text-primary` | `#111827` | Body text |
| `text-secondary` | `#1f2937` | Card text |
| `text-muted` | `#6b7280` | Subtitles, meta |
| `text-faint` | `#9ca3af` | Timestamps, hints |

### 6b. Suggestion Type Colors

| Type | Background | Left Border | Badge bg | Badge text |
|---|---|---|---|---|
| question | `#f0fdf4` | `#22c55e` | `#dcfce7` | `#16a34a` |
| talking_point | `#eff6ff` | `#3b82f6` | `#dbeafe` | `#1d4ed8` |
| answer | `#fff7ed` | `#f97316` | `#ffedd5` | `#ea580c` |
| fact_check | `#faf5ff` | `#a855f7` | `#f3e8ff` | `#9333ea` |
| clarification | `#fffbeb` | `#eab308` | `#fef9c3` | `#ca8a04` |

---

## 7. UI — Approved Production Design

### Top Navigation Bar (52px)
- Logo icon (28×28 lime square "M") + "MeetingCopilot" wordmark
- Center: editable session title pill + elapsed session timer
- Right: LIVE badge (red, only when recording) + export + settings icons

### Transcript Panel (left)
- Live waveform bar (CSS-only, 20 animated bars) — visible while recording
- Transcript chunks: timestamped cards, copy-on-hover, lime border on hover
- Mic button docked at bottom (lime = start, red = stop)
- Segment count badge in column header

### Suggestions Panel (middle)
- Newest batch at **top**, older batches stacked below with a subtle date separator
- Each suggestion: type badge + title (preview) + copy icon
- Hover reveals "Click for details →" affordance
- Bottom controls bar: auto-suggest countdown + manual "↻ Refresh" button
- "Generating…" skeleton state while fetching
- "N new" badge on column header

### Chat Panel (right)
- User bubbles: lime, dark text, bottom-right corner cut
- AI bubbles: white, border, AI avatar badge, bottom-left corner cut
- Typing indicator: 3 animated dots while streaming
- Input: white, lime focus ring, send button (lime), Enter to send

### Settings Page
- API key (password field, eye toggle)
- All 3 prompt textareas (pre-filled with optimised defaults)
- Context window number inputs
- Save button (lime, full-width)

### Status Bar (28px, bottom)
- Groq connection status + model name
- Session stats: N segments · N suggestion batches · N messages

---

## 8. Store Shape (`lib/store.ts`)

```typescript
interface SuggestionBatch {
  id: string
  suggestions: Suggestion[]        // always 3
  timestamp: string
  transcriptSnapshot: string       // what transcript looked like when generated
}

interface MeetingStore {
  // existing
  apiKey: string
  isRecording: boolean
  transcript: TranscriptChunk[]
  messages: Message[]

  // new / changed
  suggestionBatches: SuggestionBatch[]   // replaces flat suggestions[]
  sessionTitle: string
  sessionStartTime: number | null        // Date.now() when recording starts
  nextSuggestionIn: number              // seconds countdown
  isGeneratingSuggestions: boolean
  isStreamingChat: boolean

  // prompt settings (loaded from localStorage)
  settings: {
    liveSuggestionPrompt: string
    clickDetailPrompt: string
    chatSystemPrompt: string
    suggestionContextWindow: number      // default 5
    detailContextWindow: number          // default: full transcript
  }
}
```

---

## 9. Component + Module File Map

| File | Change |
|---|---|
| `lib/store.ts` | Add `suggestionBatches`, `sessionTitle`, `sessionStartTime`, `nextSuggestionIn`, `settings` |
| `lib/suggestions.ts` | Rewrite: batch of 3, retry on JSON error, configurable prompt/context |
| `lib/chat.ts` | Add `streamDetailedAnswer()` for click-to-chat, configurable system prompt |
| `lib/transcription.ts` | No change (already correct) |
| `lib/export.ts` | Export `suggestionBatches` (not flat suggestions), include all batches + timestamps |
| `lib/retry.ts` | New: `withRetry(fn, attempts, backoff)` utility |
| `lib/settings.ts` | New: load/save settings from localStorage, default prompt constants |
| `components/MeetingRoom.tsx` | New nav (session title, timer, live badge, status bar) |
| `components/TranscriptPanel.tsx` | Waveform, new chunk cards, copy-on-hover, mic button at bottom |
| `components/SuggestionsPanel.tsx` | Batched display (newest top), click handler, countdown, skeleton |
| `components/ChatPanel.tsx` | AI avatar, new bubbles, typing indicator, handles click-to-chat |
| `app/settings/page.tsx` | Add prompt editors + context window inputs |
| `app/globals.css` | Full lime token set, waveform + typing keyframes |
| `tailwind.config.ts` | Extend theme with lime palette |

---

## 10. Deployment — Vercel

- Push to GitHub (public repo)
- Connect to Vercel — zero-config Next.js deploy
- No environment variables needed (API key is user-provided at runtime via settings)
- Add `vercel.json` if any config needed (none expected)
- README must include: public URL, setup instructions, stack choices, prompt strategy, tradeoffs, observed latency numbers

---

## 11. README Requirements

The README is a deliverable they will read. Must cover:
- **Setup**: clone → install → `npm run dev` → paste API key
- **Stack choices**: why Next.js, why Groq/Whisper Turbo, why client-side only
- **Prompt strategy**: what context we pass, how we decide suggestion types, rolling window rationale
- **Tradeoffs**: 3s cycles vs 30s batches, context window size vs latency, Whisper Turbo vs Large-V3
- **Observed latency**: real p50/p95 numbers for transcript, suggestions, chat first token
- **Architecture diagram** (simple ASCII or Mermaid): audio → transcription → suggestion pipeline → chat

---

## 12. Out of Scope

- User accounts / authentication
- Database / cross-session persistence  
- Speaker diarisation
- Mobile layout
- Export formats beyond JSON
- Rate limit handling beyond retry logic
