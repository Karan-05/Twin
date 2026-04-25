#!/usr/bin/env node
/**
 * Smoke test: verifies the minimal fallback is stable and never produces
 * known bad patterns (hardcoded topics, literal placeholders, "latest topic").
 *
 * The fallback is intentionally minimal — exists to not crash when Groq
 * is unavailable, not to provide topic-specific advice.
 *
 * Run:  npx tsx scripts/fallback-smoke.ts
 */

import { buildFallbackSuggestions } from '../lib/suggestions'
import type { TranscriptChunk, MeetingContext } from '../lib/store'
import { deriveMeetingState } from '../lib/meetingState'

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
// Scenario 1: Kafka architecture question
// ---------------------------------------------------------------------------
console.log('\n[Scenario 1] Kafka architecture question')

const kafkaChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:01:05', text: 'So hey can you walk me through how Kafka works' },
  { id: '2', timestamp: '00:01:15', text: 'like the internal architecture and how it handles throughput at scale' },
]

const kafkaSuggestions = buildFallbackSuggestions(kafkaChunks)

assert(kafkaSuggestions.length === 3, 'returns 3 suggestions')
assert(
  !kafkaSuggestions.some((s) => /voice ai|asr|tts|llm pipeline/i.test(s.say ?? '')),
  `no 'say' hardcodes "Voice AI", "ASR", or "TTS"`
)
assert(
  !kafkaSuggestions.some((s) => /latest topic/i.test(s.title + (s.say ?? ''))),
  `no "latest topic" placeholder in titles or say`
)
assert(
  !kafkaSuggestions.some((s) => /\[your key point\]/i.test(s.say ?? '')),
  `no bare [your key point] placeholder in say`
)

// ---------------------------------------------------------------------------
// Scenario 2: Redis architecture question
// ---------------------------------------------------------------------------
console.log('\n[Scenario 2] Redis architecture question')

const redisChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:02:00', text: 'Well actually how does Redis handle persistence and data durability' },
  { id: '2', timestamp: '00:02:10', text: 'and what happens if the node crashes during a write' },
]

const redisSuggestions = buildFallbackSuggestions(redisChunks)

assert(redisSuggestions.length === 3, 'returns 3 suggestions')
assert(
  !redisSuggestions.some((s) => /voice ai|asr.*tts/i.test(s.say ?? '')),
  `no 'say' hardcodes Voice AI pipeline`
)
assert(
  !redisSuggestions.some((s) => /latest topic/i.test(s.title + (s.say ?? ''))),
  `no "latest topic" placeholder`
)

// ---------------------------------------------------------------------------
// Scenario 3: Generic budget discussion — no unrelated technical content
// ---------------------------------------------------------------------------
console.log('\n[Scenario 3] Generic budget discussion — not forced into technical branch')

const genericChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:04:00', text: 'I think we should move forward with the proposal' },
  { id: '2', timestamp: '00:04:10', text: 'and look at what the budget looks like next quarter' },
]

const genericSuggestions = buildFallbackSuggestions(genericChunks)

assert(genericSuggestions.length >= 1, 'returns at least 1 suggestion')
assert(
  !genericSuggestions.some((s) => /asr|tts|llm pipeline|kafka|redis|architecture in four parts/i.test(s.say ?? '')),
  `does NOT inject unrelated technical content`
)
assert(
  !genericSuggestions.some((s) => /latest topic/i.test(s.title + (s.say ?? ''))),
  `no "latest topic" placeholder`
)

// ---------------------------------------------------------------------------
// Scenario 4: MacBook Air sales ordering — no technical architecture cards
// ---------------------------------------------------------------------------
console.log('\n[Scenario 4] MacBook Air sales ordering — no technical architecture misfires')

const macChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '19:42:26', text: 'So yeah, I would like to order about 15 MacBook Airs for the team. And when can you get them delivered?' },
  { id: '2', timestamp: '19:43:00', text: 'So how would you want your MacBook Airs? Do you want any specialized customization?' },
]

const macSuggestions = buildFallbackSuggestions(macChunks)

assert(macSuggestions.length >= 1, 'returns at least 1 suggestion')
assert(
  !macSuggestions.some((s) => /explain.*architecture|production bottleneck|scale and constraints|input.*core processing.*output/i.test(s.title + (s.say ?? ''))),
  `no technical architecture suggestions for a sales ordering conversation`
)
assert(
  !macSuggestions.some((s) => /latest topic/i.test(s.title + (s.say ?? ''))),
  `no "latest topic" placeholder in Mac ordering suggestions`
)

// ---------------------------------------------------------------------------
// Scenario 5: Thin transcript (< 2 chunks) — grounding questions only
// ---------------------------------------------------------------------------
console.log('\n[Scenario 5] Thin transcript — grounding questions')

const thinChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:00:05', text: 'Okay let us get started' },
]

const thinSuggestions = buildFallbackSuggestions(thinChunks)

assert(thinSuggestions.length === 3, 'returns 3 grounding suggestions for thin transcript')
assert(
  thinSuggestions.every((s) => s.type === 'question'),
  'all suggestions are questions for thin transcript'
)
assert(
  !thinSuggestions.some((s) => /latest topic/i.test(s.title + (s.say ?? ''))),
  `no "latest topic" in thin-transcript suggestions`
)

// ---------------------------------------------------------------------------
// Scenario 6: MacBook Air mixed sales conversation — buyer delivery question wins
// ---------------------------------------------------------------------------
console.log('\n[Scenario 6] MacBook Air mixed sales conversation — stale seller prompts filtered')

const mixedSalesChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '19:40:45', text: 'Hey, so I am selling the MacBook Airs. They have both RAM and GPU support so teams can run local LLMs.' },
  { id: '2', timestamp: '19:41:22', text: 'Can you share how many of your team members would run local LLMs or GPU intensive workloads on a MacBook Air?' },
  { id: '3', timestamp: '19:43:00', text: 'I would like to order about 15 MacBook Airs for the team. And when can you get them delivered?' },
  { id: '4', timestamp: '19:43:31', text: 'Do you want any specialized customization? And is it space gray?' },
  { id: '5', timestamp: '19:44:01', text: 'Anything special that you want them to have, any software at boot time or engraved for your teams? I do not think so.' },
]

const mixedSalesContext: MeetingContext = {
  meetingType: 'Sales Call',
  userRole: 'Seller',
  goal: 'Close the order and clarify delivery and customization',
}

const mixedSalesState = deriveMeetingState(mixedSalesChunks, mixedSalesContext)
const mixedSalesSuggestions = buildFallbackSuggestions(mixedSalesChunks, mixedSalesContext, mixedSalesState)

assert(
  mixedSalesState.currentQuestion?.toLowerCase().includes('delivered') ?? false,
  `prefers the buyer delivery question over later seller customization prompts`
)
assert(
  mixedSalesSuggestions.some((s) => /delivery|order|custom/i.test(`${s.title} ${s.detail} ${s.say ?? ''}`)),
  `fallback suggestions stay on delivery/order/customization instead of drifting`
)
assert(
  !mixedSalesSuggestions.some((s) => /latest topic|\[[A-Za-z][^[\]]*\]|what matters most is(?:…|\.{3}|$)/i.test(`${s.title} ${s.detail} ${s.say ?? ''}`)),
  `no latest-topic or placeholder scaffolds in mixed sales suggestions`
)

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)
