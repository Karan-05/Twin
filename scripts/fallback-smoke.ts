#!/usr/bin/env node
/**
 * Smoke test: verifies fallback suggestions are specific and technical when the
 * transcript contains an STT-style indirect technical question.
 *
 * Run:  npx tsx scripts/fallback-smoke.ts
 * Pass: exits 0 with all assertions green
 * Fail: exits 1 with first failing assertion
 */

import { buildFallbackSuggestions } from '../lib/suggestions'
import type { TranscriptChunk } from '../lib/store'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: STT-style indirect voice AI question (the exact user transcript)
// ---------------------------------------------------------------------------
console.log('\n[Scenario 1] Indirect voice AI question via STT')

const voiceAiChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:01:05', text: 'So hey can you tell me about how voice AI assistants work' },
  { id: '2', timestamp: '00:01:15', text: 'like the technical side of it what model runs underneath' },
  { id: '3', timestamp: '00:01:25', text: 'and also how do you stop them from hallucinating' },
]

const voiceAiSuggestions = buildFallbackSuggestions(voiceAiChunks)

assert(voiceAiSuggestions.length === 3, 'returns 3 suggestions')

const titles = voiceAiSuggestions.map((s) => s.title)
const says = voiceAiSuggestions.map((s) => s.say)
const types = voiceAiSuggestions.map((s) => s.type)

assert(
  titles.some((t) => /asr|pipeline|voice/i.test(t)),
  `at least one title references pipeline/ASR (got: ${titles.join(' | ')})`
)
assert(
  says.some((s) => /asr|pipeline|tts|llm/i.test(s)),
  `at least one 'say' contains concrete pipeline terms`
)
assert(
  !says.some((s) => s.includes('[your key point]')),
  `no 'say' field contains the bare placeholder "[your key point]"`
)
assert(
  !titles.some((t) => /Re-anchor|Ask for the use case|Define the decision rule/i.test(t)),
  `no generic fallback titles (Re-anchor / Ask for the use case / Define the decision rule)`
)
assert(
  types.includes('answer'),
  `includes an 'answer' type suggestion`
)

// ---------------------------------------------------------------------------
// Scenario 2: Hallucination focus
// ---------------------------------------------------------------------------
console.log('\n[Scenario 2] Hallucination prevention question')

const hallucinationChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:02:00', text: 'Well how do you actually prevent hallucination in these LLM systems' },
  { id: '2', timestamp: '00:02:10', text: 'because we had a bad incident last quarter where the model made things up' },
]

const hallSuggestions = buildFallbackSuggestions(hallucinationChunks)

assert(hallSuggestions.length === 3, 'returns 3 suggestions')
assert(
  hallSuggestions.some((s) => /rag|retrieval|confidence|threshold/i.test(s.say)),
  `at least one 'say' mentions RAG or confidence threshold`
)
assert(
  !hallSuggestions.some((s) => s.say.includes('[your key point]')),
  `no 'say' contains bare placeholder`
)

// ---------------------------------------------------------------------------
// Scenario 3: Generic transcript — should NOT trigger technical branch
// ---------------------------------------------------------------------------
console.log('\n[Scenario 3] Non-technical transcript — generic fallback expected')

const genericChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:03:00', text: 'I think we should move forward with the proposal' },
  { id: '2', timestamp: '00:03:10', text: 'and look at what the budget looks like next quarter' },
]

const genericSuggestions = buildFallbackSuggestions(genericChunks)

assert(genericSuggestions.length >= 1, 'returns at least 1 suggestion')
// These should be the standard fallback, NOT voice AI specific
assert(
  !genericSuggestions.some((s) => /asr|pipeline|tts|llm/i.test(s.say)),
  `does NOT force voice AI content into generic transcript`
)

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
