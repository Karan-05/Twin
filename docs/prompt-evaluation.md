# Prompt Evaluation

Strong prompt engineering is not just writing a clever system prompt. It needs an eval loop.

## What this repo now includes

- `eval/scenarios.json` — curated meeting scenarios across sales, interview, standup, and discovery contexts
- `scripts/eval-prompts.ts` — runs the real prompt pipeline against those scenarios using Groq
- LLM-as-judge scoring for:
  - live suggestion quality
  - click-to-expand detailed answers
- `eval/results/latest.json` — latest structured eval output for comparison across prompt versions

## Why this matters

If you want a TwinMind reviewer to be genuinely impressed, the prompts need to be:

- grounded in what was actually said
- timely for the current conversational moment
- diverse across the 3 suggestions
- directive enough to act on immediately
- tailored to the user role and meeting type
- robust against repetition across suggestion batches
- trustworthy when session prep context exists but transcript evidence is thin

Those are exactly the dimensions the harness scores.

The latest prompt pipeline also evaluates more than raw transcript text. It feeds the model a compact meeting-state object plus recent transcript delta, and the suggestion path can internally rerank candidate ideas before rendering the top 3. That matters because a strong copilot is not just fluent — it is selective.

## How to run

```bash
export GROQ_API_KEY=gsk_...
npm run eval:prompts
```

Useful variants:

```bash
# Validate fixtures only, no API calls
npm run eval:prompts -- --dry-run

# Only one scenario
npm run eval:prompts -- --fixture sales-objection

# Suggestions only
npm run eval:prompts -- --mode suggestions

# Detailed answers only
npm run eval:prompts -- --mode detail
```

The fixture set now includes multilingual interruption and messy cross-talk cases to better reflect real meetings.

## How to interpret results

- `suggestionScore >= 4.5` consistently across fixtures is a strong bar
- `impressive = true` means the evaluator judged the batch as notably helpful in a real meeting
- `shouldShip = true` means the output is good enough without prompt edits

If a scenario scores low, the next step is not random prompt tweaking. Instead:

1. inspect the transcript signals for that scenario
2. inspect the exact suggestions produced
3. identify which dimension failed: grounding, timing, diversity, actionability, or relevance
4. change the prompt or preprocessing for that failure mode only
5. rerun the same fixture

## Honest assessment

Are the prompts now following strong prompt-engineering strategies? **Yes.**

Are they guaranteed to be the best possible? **No — not without repeated eval runs against real and synthetic meeting fixtures plus human taste-testing.**

This harness is the mechanism to close that gap.
