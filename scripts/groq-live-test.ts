#!/usr/bin/env node
/**
 * Empirical smoke test: calls the exact same code path the live app uses.
 * Covers Sales Call (MacBook Air), Job Interview technical (Redis, Kafka).
 *
 * Run:  GROQ_API_KEY=<key> npx tsx scripts/groq-live-test.ts
 */

import { generateSuggestionBatch } from '../lib/suggestions'
import { DEFAULT_SETTINGS } from '../lib/settings'
import type { TranscriptChunk, MeetingContext } from '../lib/store'

const apiKey = process.env.GROQ_API_KEY
if (!apiKey) {
  console.error('Set GROQ_API_KEY env var before running this script.')
  process.exit(1)
}

async function runTest(label: string, chunks: TranscriptChunk[], ctx: MeetingContext) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`[${label}]`)
  console.log('─'.repeat(60))

  const batch = await generateSuggestionBatch(chunks, apiKey!, DEFAULT_SETTINGS, ctx, [], undefined, {})

  batch.suggestions.forEach((s, i) => {
    console.log(`\n  ${i + 1}. [${s.type}] ${s.title}`)
    console.log(`     DETAIL: ${s.detail.slice(0, 120)}…`)
    if (s.say) console.log(`     SAY: ${s.say}`)
  })

  // Basic quality assertions
  const titles = batch.suggestions.map((s) => s.title)
  const saysAndTitles = batch.suggestions.flatMap((s) => [s.title, s.say ?? '', s.detail])

  const hasLatestTopic = saysAndTitles.some((t) => /latest topic|current topic/i.test(t))
  const hasVoiceAiHardcode = saysAndTitles.some((t) => /voice ai|asr.*tts|asr.*llm/i.test(t))
  const hasPlaceholder = saysAndTitles.some((t) => /\[your key point\]|what matters most is\.\.\.|here's the direct answer:/i.test(t))

  console.log(`\n  CHECKS:`)
  console.log(`  ${hasLatestTopic ? '✗ FAIL' : '✓ pass'} no "latest topic" literal`)
  console.log(`  ${hasVoiceAiHardcode ? '✗ FAIL' : '✓ pass'} no hardcoded Voice AI / ASR→TTS`)
  console.log(`  ${hasPlaceholder ? '✗ FAIL' : '✓ pass'} no bare placeholder in say fields`)
  console.log(`  ${batch.suggestions.length === 3 ? '✓ pass' : '✗ FAIL'} returns 3 suggestions`)
}

async function main() {
  // --- Sales Call: MacBook Air ordering (the screenshot scenario) ---
  await runTest(
    'Sales Call — MacBook Air ordering',
    [
      { id: '1', timestamp: '19:42:26', text: 'So yeah, I would like to order about 15 MacBook Airs for the team. And when can you get them delivered?' },
      { id: '2', timestamp: '19:43:00', text: 'So how would you want your MacBook Airs? Do you want any specialized customization?' },
    ],
    { meetingType: 'Sales Call', userRole: 'Sales Representative', goal: 'Close the MacBook order', prepNotes: '' }
  )

  // --- Job Interview: Redis technical question ---
  await runTest(
    'Job Interview — Redis persistence (non-Voice-AI technical topic)',
    [
      { id: '1', timestamp: '00:05:00', text: 'Tell me about a time you debugged a hard production issue.' },
      { id: '2', timestamp: '00:06:30', text: 'How does Redis handle data persistence, and what happens if the node crashes during a write?' },
    ],
    { meetingType: 'Job Interview', userRole: 'Candidate', goal: 'Land the senior engineering role', prepNotes: '' }
  )

  // --- Job Interview: Kafka technical question ---
  await runTest(
    'Job Interview — Kafka ordering across partitions',
    [
      { id: '1', timestamp: '00:10:00', text: 'Can you walk me through how Kafka handles message ordering across partitions?' },
      { id: '2', timestamp: '00:10:30', text: 'And how would you handle exactly-once delivery in a real production system?' },
    ],
    { meetingType: 'Job Interview', userRole: 'Candidate', goal: 'Demonstrate systems design expertise', prepNotes: '' }
  )

  // --- Investor Pitch: TAM claim ---
  await runTest(
    'Investor Pitch — TAM claim',
    [
      { id: '1', timestamp: '00:02:00', text: 'The market here is enormous — we are targeting a TAM of fifty billion dollars.' },
      { id: '2', timestamp: '00:02:30', text: 'So what is your wedge into that market, and who is your most dangerous incumbent?' },
    ],
    { meetingType: 'Investor Pitch', userRole: 'Founder', goal: 'Close Series A lead', prepNotes: '' }
  )

  // --- Generic meeting with thin transcript ---
  await runTest(
    'Thin transcript — grounding fallback',
    [
      { id: '1', timestamp: '00:00:05', text: 'Okay let us get started.' },
    ],
    { meetingType: 'General', userRole: 'Participant', goal: '', prepNotes: '' }
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
