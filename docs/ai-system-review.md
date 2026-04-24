# AI System Review

This project is intentionally optimized for the assignment: high-quality live suggestions, low setup friction, and strong prompt/control over a single-session meeting copilot.

## Strong decisions already present

- **Freshness-first architecture**: the app now pairs a fast provisional transcript lane with stable committed chunks, and suggestions can refresh from cadence or event triggers instead of waiting on a single timer.
- **Grounded generation**: prompts explicitly forbid invention and push the model to cite or quote transcript evidence.
- **Role-conditioned prompting**: meeting type and participant role shape suggestions from the first batch.
- **Structured outputs**: suggestion generation uses JSON-only responses with normalization and retry logic.
- **Exportability**: full transcript, suggestion batches, chat, and prompts are exportable for evaluator review.

## Agentic design strategies used

- **Deterministic pre-processing before LLM calls**: the app extracts recent questions, numeric claims, commitments, blockers, deadlines, loop signals, and likely topics before suggestion/chat generation.
- **Compact meeting-state memory**: a lightweight session state tracks the current question, blocker, risky claim, decision focus, stakeholders, and loop status so prompts operate on state plus delta, not raw transcript alone.
- **Lightweight reranking**: the system still scores suggestions for urgency, specificity, role fit, and speakability, but the live prompt now aims to return the final 3 directly instead of leaning on heavy over-generation.
- **Separation of fast and slow loops**: transcript + suggestions run on the live loop; intelligence extraction runs on a slower background loop.
- **Memory isolation**: prior-session memory is injected as a separate context block instead of contaminating the raw transcript.
- **Guardrails over autonomy**: the system does not blindly act; it recommends the next best move while keeping the user in control.
- **Fallback design**: if the model output is weak or malformed, deterministic fallback suggestions still keep the experience useful.

## ETL / backend / API patterns reflected here

- **Light ETL in the client**: normalize transcript chunks, merge tiny fragments, classify sentiment, derive meeting state, and extract context signals before inference.
- **Schema-aware parsing**: JSON cleaning, normalization, and de-duplication protect the UI from malformed model output.
- **Retry with stricter instructions**: the system retries failed structured generations with a stronger JSON-only prefix.
- **State separation**: transcript, suggestions, chat, settings, and intelligence summary are cleanly separated in the store.
- **Failure isolation**: transcription, suggestions, chat, and intelligence extraction can fail independently without killing the whole session.

## What I would do next for production scale

- **Move Groq calls behind a backend proxy** for API-key safety, request tracing, rate limiting, and cost controls.
- **Add prompt versioning + evaluation datasets** so suggestion quality can be measured before shipping prompt changes.
- **Add observability**: latency histograms, JSON-parse failure rate, suggestion click-through rate, and transcript-to-suggestion timing.
- **Add PII controls**: optional redaction before export and server-side encrypted session handling if persistence is introduced.
- **Add richer meeting memory**: embeddings or structured retrieval over prior sessions instead of simple same-type session recall.
- **Add diarization / VAD** if the product expands beyond the assignment’s scope.

## Current tradeoff summary

- **Best for assignment scoring**: browser-only setup, minimal ops, easy deployment, strong prompt control, and a repeatable prompt-eval harness.
- **Not yet ideal for enterprise scale**: no protected backend, no centralized telemetry, and no server-side governance around rate limits or key management.
