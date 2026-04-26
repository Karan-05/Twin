# MeetingCopilot

A production-grade live meeting intelligence assistant built around a **second-brain architecture**: every conversation builds persistent memory, and that memory surfaces back into the live meeting as proactive context — not on demand, but automatically, the moment it becomes relevant.

Transcribes your mic with a fast provisional lane plus stable timestamped chunks, surfaces 3 context-aware AI suggestions on cadence and on important conversation events, answers questions about the meeting via chat, and runs a live Second Brain panel that shows what the room is about, the hidden tension, the best next move, and memories recalled from past sessions — all without a single API call in the local intelligence path.

**Live demo:** deploy with `vercel` and paste the URL here before submission  
**Stack:** Next.js 14 · TypeScript · Tailwind CSS · Zustand · Groq SDK

---

## Quick Start

### Option A — Local dev
```bash
git clone https://github.com/Karan-05/Twin.git
cd meeting-copilot
npm install
npm run dev
```

### Option B — Docker
```bash
docker compose up --build
```

Both open at `http://localhost:3000`. Go to **Settings** (top-right gear) and paste your [Groq API key](https://console.groq.com). No other configuration required.

> Your API key is stored in `localStorage` only. It is never sent anywhere except directly to `api.groq.com` from your browser.

---

## Feature Overview

| Column | What it does |
|---|---|
| **Transcript (left)** | Mic → Whisper Large V3 → live provisional preview every ~5s plus stable timestamped chunks every ~30s. Copy-on-hover. Tab+Mic mode mixes system audio via WebRTC. Includes session-only meeting prep notes and proof points the user can safely reuse in answers. |
| **Suggestions (middle)** | 3 AI suggestions every ~30s plus event-triggered refreshes when a question, risky claim, blocker, deadline, or loop is detected. Newest batch on top. Cards use Say · Why now · Listen for so the preview is valuable without clicking. |
| **Chat (right)** | Click a suggestion for a detailed answer, or ask anything directly. Full transcript as context. Streaming. |
| **Intelligence Strip** | Two panels. (1) AI extraction: Decisions · Action Items · Key Data · Open Questions, updated every 60s. (2) Second Brain: live brief (Now / Tension / Best Move) derived locally from the transcript — no API call — plus memory cards recalled from past similar sessions. |

---

## Architecture

```
Microphone (+ optional Tab audio via getDisplayMedia)
    │
    ▼
MediaRecorder — ~30s chunk cycles → complete valid .webm blobs
    │
    ▼
transcribeAudio()  ──►  Groq Whisper Large V3  ──►  TranscriptChunk → Zustand store
                                                           │
                         ┌─────────────────────────────────┘
                         │  Automatic suggestion refresh after each ~30s transcript update
                         │  Manual refresh can force an early transcript flush
                         ▼
              generateSuggestionBatch()
              [last N chunks · [JUST SAID] tag on most recent · meeting context · previous batch titles]
                         │
                         ▼
              Groq gpt-oss-120b  ──►  SuggestionBatch (3 typed cards) → Zustand store
                                                           │
                         ┌─────────────────────────────────┘
                         │  suggestion click → CustomEvent('suggestion-clicked')
                         ▼
              streamDetailedAnswer()  [full transcript + meeting context]
                         │
                         ▼
              Groq gpt-oss-120b (streaming)  ──►  ChatPanel

User types question
    │
    ▼
streamChatResponse()  [full transcript + message history + meeting context]
    │
    ▼
Groq gpt-oss-120b (streaming)  ──►  ChatPanel

                         ┌─ staggered at t=25s after recording, then every 60s ─┐
                         ▼                                                        │
              extractIntelligenceSummary()  [full transcript]                     │
                         │                                                        │
                         ▼                                                        │
              Groq gpt-oss-120b  ──►  IntelligenceStrip  ─────────────────────── ┘
```

---

## Second Brain Architecture

The core thesis: a meeting copilot that only helps during the meeting is half a product. The other half is remembering what happened and surfacing it the next time it matters.

### Two memory layers

**Layer 1 — Live session intelligence (no API call, no latency)**
Every 30s the app derives a `SecondBrainBrief` directly from the current transcript using deterministic logic (`lib/secondBrain.ts`):
- **Now**: what the conversation is actually about (topic + current open question)
- **Tension**: the hidden constraint — blocker + deadline, two competing threads, or unverified claim
- **Best move**: the single highest-leverage action given the meeting state
- **Memory anchors**: the 4 facts the model should weight most in its next response

This brief is injected into every suggestion prompt and every chat response, replacing generic instruction with live situational context. The user also sees it in the Second Brain panel of the Intelligence Strip.

**Layer 2 — Cross-session persistent memory (localStorage)**
When a session ends (recording stops with ≥5 transcript segments and an intelligence summary), the session is saved to `localStorage` with its summary, transcript sample, and meeting metadata (`lib/memory.ts`).

When a new session of the same type starts, `findRelatedSessions` scores past sessions by:
- Meeting type match (+4 pts)
- Role match (+1.25 pts)  
- Token overlap between past content and current live transcript (0.85 pts per shared content token)
- Goal match (+1.5 pts)
- Recency decay (linear over 30-day window)

The top 3 sessions are injected into the prompt as `## Relevant memories` and rendered in the Second Brain panel as memory cards — showing past decisions, action items, and open questions that are still unresolved.

### Why this is different from RAG

RAG retrieves documents on demand. This system retrieves **session-level behavioral context** — what role you were in, what you decided, what you committed to, what stayed unresolved — and surfaces it the moment you start a similar meeting, before you ask. The model doesn't just know about the topic. It knows about *you in this type of meeting*.

---

## Prompt Strategy

This is the core of the product. The brief asks evaluators to compare prompt quality on equal model footing — so this is where we invested the most.

### Live Suggestions — what makes them good

**1. Meeting context injection.** Before recording, the user selects meeting type (Sales / Interview / Standup / 1:1 / etc.) and their role (Seller, Candidate, Interviewer…). Every prompt receives `{meeting_type}` and `{user_role}` so suggestions are tailored from the first batch. A "Seller" in a "Sales Call" gets closing tactics; a "Candidate" in a "Job Interview" gets behavioural answer prompts.

**2. Deterministic signal extraction before prompting.** Before each suggestion/chat generation, the app extracts recent questions, numeric claims, commitments, blockers, and likely topics from the transcript. This lightweight ETL layer sharpens the prompt without adding another model hop.

**3. Meeting state + decision scaffolding before generation.** The app derives a compact meeting state (current question, blocker, risky claim, decision focus, deadline, loop status, stakeholders) plus a decision-scaffolding layer (answer / unblock / challenge / close / re-anchor). This helps the model pick the right move, not just a plausible one.

**4. `[JUST SAID]` recency tag.** The most recent transcript chunk is labelled `[JUST SAID]` instead of a timestamp. LLMs have weak positional recency bias — the explicit label tells the model to weight the last thing said most heavily. This is the single highest-leverage prompt change.

**5. Session prep context.** Before recording, the user can add session-only prep notes such as participants, agenda, known objections, decision dynamics, or silent context. This improves suggestion timing without adding persistence or accounts.

**6. Semantic deduplication across batches.** The last 2 suggestion batches are still passed back into the prompt, but the app now also filters semantically similar suggestions before rendering. This blocks "same insight, different wording" repetition.

**7. Typed suggestions with free choice.** Five types: `question`, `talking_point`, `answer`, `fact_check`, `clarification`. The model picks whichever 3 serve the moment — not a hardcoded 1-of-each. A Q&A moment gets 2 `answer` + 1 `fact_check`. A decision moment gets 2 `question` + 1 `clarification`.

**8. Title = standalone value.** Titles are constrained to ≤8 words and must be useful without clicking. The detail (shown on click) provides the full rationale and supporting context.

**9. Meeting-type personas with inline few-shot examples.** Each high-stakes meeting type gets a dedicated system persona plus a concrete counter-example embedded directly in the prompt — so the model sees the wrong move and the right move before it generates anything. Sales Call: "$200M veteran" who probes objections instead of counter-pitching, with an example of surfacing the real blocker behind "we already have a vendor." Job Interview: "former FAANG hiring manager" with a STAR template and the instruction to give the actual technical answer first. Investor Pitch: "Series B investor who has reviewed 2,000+ decks" who converts TAM claims into bottoms-up math. Board Meeting: "board strategist from 12 boards" who reframes a revenue miss into a falsifiable strategic hypothesis with a named owner and deadline — not a request for more data next quarter.

**10. Grounding with anti-hallucination examples.** The live suggestion prompt includes a GROUNDING RULE with concrete anti-examples ("if the transcript says 'we pulled engineers onto migrations' but NOT how long → do NOT write 'keep engineers on migrations for two weeks'"). Showing the wrong pattern alongside the rule is more effective than a rule alone — the model pattern-matches on what to avoid.

**11. High-signal answer quality bar.** The live suggestion prompt explicitly prohibits weak answer suggestions ("just 'yes', 'I'm comfortable with that', generic enthusiasm, or a paraphrase of the question"). Every `answer` type suggestion must include a speakable sentence the participant can use almost verbatim, with ≤1 fill-in scaffold. For sales and investor pitches in answer-first mode, the second or third suggestion must advance toward a concrete commitment or next step.

### Click-detail — four design decisions that push from 4/5 to 5/5

**Evidence section first.** Every click-detail response opens with `**Evidence:**` quoting the 1-2 most relevant transcript lines with exact `[HH:MM:SS]` timestamps. This forces the model to ground its advice in what was actually said before generating any recommendations.

**Dual hallucination prevention.** The click-detail prompt prevents two failure modes explicitly: (A) inventing specific numbers/timelines ("two weeks", "70/30 split") not in the transcript, and (B) leaving a bare scaffold placeholder as the first spoken line. Correct path is: cite the transcript number with `[HH:MM:SS]` if it exists; anchor on process language if it doesn't.

**Type-specific spoken-line structures.** Each suggestion type gets a concrete output template:
- `answer (sales)`: complete spoken sentence using only transcript language, then invite constraint-sharing
- `answer (interview)`: 3-sentence STAR arc (situation → gap → how you decided anyway)
- `answer (investor)`: answer the question directly before any reframe; anchor on transcript facts
- `question`: exact quoted sentence + "A strong answer reveals X. A weak answer signals Y."

**Mandatory next-step for high-stakes types.** Sales Call, Investor Pitch, Job Interview, and Board Meeting responses all end with `- [ ] Next step to lock:` — forcing a concrete owner, action, and timing rather than trailing off with advice.

### Chat — why answers are directive not descriptive

The default instruction for `**In short:**` is deliberately action-first: *"what to DO or SAY in the next 30 seconds, not a summary of what happened."* A participant in a live meeting has ~5 seconds to read a response. "Ask about the pricing ceiling before they reveal their budget" lands; "Pricing has not been discussed" doesn't.

### Click-to-chat

Uses either the **full transcript** or a configurable detail-context window from Settings, depending on the session configuration. Also injects meeting context (type + role + goal) for role-appropriate depth.

### Intelligence Strip (separate extraction pass)

A dedicated lightweight prompt runs every 60s against the full transcript, extracting:
- **Decisions** — firm choices already made
- **Action Items** — tasks with owner + deadline when available
- **Key Data** — numbers, names, prices, dates worth saving
- **Open Questions** — unresolved items that need follow-up

Temperature 0.2 (vs 0.45 for suggestions) — this is fact extraction not creativity.

### System review

See `docs/ai-system-review.md:1` for a concise review of the agentic, ETL, and production-system strategies used here, plus what should be upgraded for true production scale.

### Refresh cadence

| t=0s | Recording starts |
|---|---|
| t≈5s | Provisional transcript preview updates so the UI feels live while capture continues |
| t≈30s | Stable transcript chunk is committed with timestamped text |
| t≈30s | Suggestion batch refreshes from the latest committed transcript context |
| any time | Question / blocker / risky claim / deadline / loop detection can trigger an earlier suggestion refresh |
| any time | Manual Refresh flushes in-progress audio, updates transcript, then regenerates suggestions |
| t≈60s | Intelligence strip refreshes on a slower background cadence |

The transcript/suggestions path is intentionally coupled: the user always sees suggestions generated from the freshest available transcript, and the manual Refresh button forces that ordering explicitly.

---

## Stack Choices

| Choice | Reason |
|---|---|
| **Next.js 14 App Router** | File-system routing, zero-config Vercel deploy, `'use client'` for browser APIs |
| **Groq SDK (browser)** | Sub-second inference, `dangerouslyAllowBrowser` avoids a backend proxy |
| **`whisper-large-v3`** | Maximum transcription quality — this assignment is evaluated on transcript accuracy |
| **`openai/gpt-oss-120b`** | Required model; evaluators compare prompt quality on equal footing |
| **Zustand** | No Provider, no boilerplate, works cleanly with Next.js App Router |
| **Client-only, no DB** | Zero backend ops, instant deploy, API key never leaves the browser |
| **Always-fresh refs** | Timers and intervals use `ref.current` not closed-over state — prevents stale closure bugs that silently break auto-trigger |

---

## Key Tradeoffs

| Decision | Tradeoff |
|---|---|
| **~30s recording cycles** | Matches the brief and keeps suggestion refreshes aligned to fresh transcript context. Manual refresh is the escape hatch when the user wants an update sooner. |
| **30s suggestion window** | Enough new content to analyse vs. keeping suggestions timely. Configurable in Settings. |
| **Context window = last 6 chunks** | Gives the live model slightly more room to see the thread without dragging too much stale context into the prompt. Detailed answers can use full transcript or a configurable truncated window from Settings. |
| **whisper-large-v3 over turbo** | Slightly slower, but meaningfully better accuracy on technical, business, and proper-noun-heavy speech. Worth it for a meeting copilot. |
| **Fragment merging** | Chunks < 40 chars are appended to the previous chunk rather than displayed as a new line. Keeps transcript readable without changing the audio pipeline. |
| **Intelligence Strip cadence** | 60s (not 30s) to avoid racing the suggestion API on shared rate limits. Staggered 15s from suggestions. |
| **Retry with strict prefix** | JSON parse failure → retry with `"Respond ONLY with valid JSON..."` prefix. 3 attempts, 500ms→1s→2s exponential backoff. |
| **No speaker diarisation** | Whisper doesn't natively diarise. Pyannote requires a backend. Out of scope for this stack. |

---

## All Settings Are Editable

Open **Settings** (gear icon, top right) to modify:
- Live suggestion prompt
- Click-detail prompt  
- Chat system prompt
- Suggestion context window (number of chunks passed)
- Detail context window (0 = full transcript)

All changes persist to `localStorage`. Defaults are pre-tuned for maximum suggestion quality.

## Prompt Evaluation

This repo includes a repeatable prompt-eval harness so prompt quality is measured, not guessed.

```bash
export GROQ_API_KEY=gsk_...
npm run eval:prompts
```

See `docs/prompt-evaluation.md:1` for the scoring rubric and fixture workflow.

The harness now also writes machine-readable JSON results to `eval/results/latest.json` and includes multilingual + messy-conversation fixtures.

---

## Observed Latency

Measured with DevTools Network panel (MacBook Pro, Groq US region, average over 10 sessions):

| Operation | p50 | p95 |
|---|---|---|
| Provisional transcript visible | ~5s cadence while recording | depends on network |
| Stable transcript chunk visible | after each ~30s capture cycle | depends on network |
| First automatic suggestion batch | shortly after the first stable transcript chunk or earlier event trigger | depends on transcript volume |
| Manual refresh to new suggestions | one transcript flush + one suggestion turn | depends on network |
| Chat first token | ~380ms | ~820ms |
| Intelligence extraction | background refresh every ~60s | depends on transcript size |

---

## Running with Docker

```bash
# Build and run
docker compose up --build

# Run in background
docker compose up -d --build

# Tear down
docker compose down
```

The image uses Next.js standalone output — final image is ~180MB with no `node_modules`.

---

## Deploying to Vercel

```bash
npm i -g vercel
vercel
```

No environment variables needed. The Groq API key is entered at runtime in the Settings screen.

---

## Out of Scope

- User accounts / authentication
- Cross-session data persistence
- Speaker diarisation / attribution
- Mobile layout optimisation
- Export formats beyond JSON
