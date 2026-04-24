#!/usr/bin/env node
/**
 * Smoke test: verifies fallback suggestions are specific to the actual
 * technical topic and never hardcode "Voice AI" or "ASR→LLM→TTS".
 *
 * Run:  npx tsx scripts/fallback-smoke.ts
 */

import { buildFallbackSuggestions } from '../lib/suggestions'
import type { TranscriptChunk, MeetingContext } from '../lib/store'

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
// Scenario 1: Kafka — STT-style indirect technical question
// ---------------------------------------------------------------------------
console.log('\n[Scenario 1] Kafka architecture question')

const kafkaChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:01:05', text: 'So hey can you walk me through how Kafka works' },
  { id: '2', timestamp: '00:01:15', text: 'like the internal architecture and how it handles throughput at scale' },
]

const kafkaSuggestions = buildFallbackSuggestions(kafkaChunks)

assert(kafkaSuggestions.length === 3, 'returns 3 suggestions')
assert(
  kafkaSuggestions.some((s) => /kafka/i.test(s.title)),
  `at least one title references "Kafka" (got: ${kafkaSuggestions.map(s => s.title).join(' | ')})`
)
assert(
  kafkaSuggestions.some((s) => /kafka/i.test(s.say)),
  `at least one 'say' references "Kafka"`
)
assert(
  !kafkaSuggestions.some((s) => /voice ai|asr|tts|llm pipeline/i.test(s.say)),
  `no 'say' hardcodes "Voice AI", "ASR", or "TTS"`
)
assert(
  kafkaSuggestions.some((s) => s.type === 'answer'),
  `includes an 'answer' type suggestion`
)

// ---------------------------------------------------------------------------
// Scenario 2: Redis — STT-style indirect technical question
// ---------------------------------------------------------------------------
console.log('\n[Scenario 2] Redis architecture question')

const redisChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:02:00', text: 'Well actually how does Redis handle persistence and data durability' },
  { id: '2', timestamp: '00:02:10', text: 'and what happens if the node crashes during a write' },
]

const redisSuggestions = buildFallbackSuggestions(redisChunks)

assert(redisSuggestions.length === 3, 'returns 3 suggestions')
assert(
  redisSuggestions.some((s) => /redis/i.test(s.title)),
  `at least one title references "Redis" (got: ${redisSuggestions.map(s => s.title).join(' | ')})`
)
assert(
  redisSuggestions.some((s) => /redis/i.test(s.say)),
  `at least one 'say' references "Redis"`
)
assert(
  !redisSuggestions.some((s) => /voice ai|asr.*tts/i.test(s.say)),
  `no 'say' hardcodes Voice AI pipeline`
)

// ---------------------------------------------------------------------------
// Scenario 3: Voice AI — still works, references the topic dynamically
// ---------------------------------------------------------------------------
console.log('\n[Scenario 3] Voice AI question — handled dynamically, not hardcoded')

const voiceChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:03:00', text: 'So hey can you tell me about how voice AI assistants work' },
  { id: '2', timestamp: '00:03:10', text: 'like what model runs underneath and how do you stop hallucination' },
]

const voiceSuggestions = buildFallbackSuggestions(voiceChunks)

assert(voiceSuggestions.length === 3, 'returns 3 suggestions')
assert(
  !voiceSuggestions.some((s) => /^Re-anchor|^Ask for the use case|^Define the decision rule/i.test(s.title)),
  `no generic fallback titles`
)
assert(
  !voiceSuggestions.some((s) => s.say === `Here's the direct answer on latest topic: [your key point] — and here's why that matters for your use case.`),
  `does not produce the bare [your key point] placeholder say`
)

// ---------------------------------------------------------------------------
// Scenario 4: Generic transcript — no technical branch triggered
// ---------------------------------------------------------------------------
console.log('\n[Scenario 4] Generic budget discussion — not forced into technical branch')

const genericChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:04:00', text: 'I think we should move forward with the proposal' },
  { id: '2', timestamp: '00:04:10', text: 'and look at what the budget looks like next quarter' },
]

const genericSuggestions = buildFallbackSuggestions(genericChunks)

assert(genericSuggestions.length >= 1, 'returns at least 1 suggestion')
assert(
  !genericSuggestions.some((s) => /asr|tts|llm pipeline|kafka|redis/i.test(s.say)),
  `does NOT inject unrelated technical content`
)

// ---------------------------------------------------------------------------
// Scenario 5: LLM question — no "latest topic" collapse
// ---------------------------------------------------------------------------
console.log('\n[Scenario 5] LLM question — preserves the actual topic and gives concrete content')

const llmChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:05:00', text: 'What is LLM ??' },
  { id: '2', timestamp: '00:05:10', text: 'So yeah how does an LLM actually work with tokenization and embeddings and how does it respond intelligently' },
]

const llmSuggestions = buildFallbackSuggestions(llmChunks)

assert(llmSuggestions.length === 3, 'returns 3 suggestions')
assert(
  llmSuggestions.some((s) => /llm/i.test(s.title)),
  `at least one title references "LLM" (got: ${llmSuggestions.map(s => s.title).join(' | ')})`
)
assert(
  llmSuggestions.some((s) => /tokeniz|embedding|attention|next token/i.test(s.say)),
  `at least one 'say' includes concrete LLM mechanics`
)
assert(
  !llmSuggestions.some((s) => /latest topic/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not collapse the subject to "latest topic"`
)

// ---------------------------------------------------------------------------
// Scenario 6: Generic concept question — no placeholder answer scaffolds
// ---------------------------------------------------------------------------
console.log('\n[Scenario 6] Generic concept question — no placeholder scaffolds')

const conceptChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:06:00', text: 'What is product market fit and why does it matter so much' },
  { id: '2', timestamp: '00:06:12', text: 'I keep hearing it everywhere but I want a clean way to explain it in a meeting' },
]

const conceptSuggestions = buildFallbackSuggestions(conceptChunks)

assert(conceptSuggestions.length === 3, 'returns 3 suggestions')
assert(
  !conceptSuggestions.some((s) => /\[(your|specific|key|metric|example|point|outcome)/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not use placeholder-style scaffolds in generic topic fallbacks`
)
assert(
  conceptSuggestions.some((s) => /what it is|why it matters|one axis|trade-off|directly/i.test(s.say)),
  `includes a concrete, speakable answer structure for a generic topic`
)

// ---------------------------------------------------------------------------
// Scenario 7: Sales pitch about voice AI agents — not treated as architecture
// ---------------------------------------------------------------------------
console.log('\n[Scenario 7] Voice AI agent sales call — pitch questions stay product-level')

const salesChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:07:00', text: 'Thank you thank you.' },
  { id: '2', timestamp: '00:07:10', text: 'We are building and providing real time voice AI agents for calling and deal sourcing workflows so companies do not need human teams only working eight hours a day.' },
  { id: '3', timestamp: '00:07:28', text: 'The agents stay available 24 7 and cost less than a human workforce for repetitive conversations.' },
  { id: '4', timestamp: '00:07:42', text: 'Would you like to know more about that?' },
  { id: '5', timestamp: '00:07:55', text: 'What kind of agents are we talking about? I would like to know more about the agents.' },
]

const salesContext: MeetingContext = {
  meetingType: 'Sales Call',
  userRole: 'Seller',
  goal: 'Explain the product clearly and qualify the right workflow'
}

const salesSuggestions = buildFallbackSuggestions(salesChunks, salesContext)

assert(salesSuggestions.length === 3, 'returns 3 suggestions')
assert(
  !salesSuggestions.some((s) => /thank/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not collapse onto filler like "thank"`
)
assert(
  !salesSuggestions.some((s) => /explain .*architecture|latency budget|consistency requirements/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not force the sales question into a technical architecture fallback`
)
assert(
  salesSuggestions.some((s) => /workflow|24\/7|24 7|deal sourcing|calling/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `anchors the answer on product workflows and economics already in the pitch`
)

// ---------------------------------------------------------------------------
// Scenario 8: Product knowledge question — broad topic, not hardcoded
// ---------------------------------------------------------------------------
console.log('\n[Scenario 8] Product knowledge question — stays product-level')

const macbookChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:08:00', text: 'We are selling the MacBook Air to developers and students who want a lightweight laptop.' },
  { id: '2', timestamp: '00:08:12', text: 'What are the M1 configurations and is macOS good for coding?' },
]

const macbookContext: MeetingContext = {
  meetingType: 'Sales Call',
  userRole: 'Seller',
  goal: 'Answer product questions clearly and connect them to buyer fit',
}

const macbookSuggestions = buildFallbackSuggestions(macbookChunks, macbookContext)

assert(macbookSuggestions.length === 3, 'returns 3 suggestions')
assert(
  macbookSuggestions.some((s) => /macbook|m1/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `keeps the actual product/topic in view`
)
assert(
  !macbookSuggestions.some((s) => /latency budget|throughput|consistency requirements|architecture/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not force a product question into a systems-architecture answer`
)
assert(
  macbookSuggestions.some((s) => /workflow|use case|trade-off|product|coding/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `gives a product-knowledge style answer frame instead of a coaching placeholder`
)

// ---------------------------------------------------------------------------
// Scenario 9: General knowledge question — direct answer framing
// ---------------------------------------------------------------------------
console.log('\n[Scenario 9] General knowledge question — answer-first framing')

const geographyChunks: TranscriptChunk[] = [
  { id: '1', timestamp: '00:09:00', text: 'Where is Los Angeles?' },
  { id: '2', timestamp: '00:09:06', text: 'I want a clean direct answer before we move on.' },
]

const geographySuggestions = buildFallbackSuggestions(geographyChunks)

assert(geographySuggestions.length === 3, 'returns 3 suggestions')
assert(
  geographySuggestions.some((s) => /los angeles/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `keeps the actual location topic instead of collapsing to a generic label`
)
assert(
  geographySuggestions.some((s) => s.type === 'answer'),
  `includes a direct answer suggestion for a factual question`
)
assert(
  !geographySuggestions.some((s) => /latency|architecture|pipeline|next step|owner/i.test(`${s.title} ${s.detail} ${s.say}`)),
  `does not turn a factual location question into architecture or meeting-process advice`
)

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)
