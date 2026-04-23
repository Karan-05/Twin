import type { MeetingContext, TranscriptChunk, SuggestionType } from './store'
import { extractConversationSignals } from './contextSignals'

type ScaffoldingMode = 'answer_now' | 'unblock' | 'challenge_claim' | 'close_loop' | 're_anchor'

const MODE_LABELS: Record<ScaffoldingMode, string> = {
  answer_now: 'Answer or probe the open question',
  unblock: 'Unblock a hidden risk or ambiguity',
  challenge_claim: 'Pressure-test the risky claim',
  close_loop: 'Lock the next step before drift',
  re_anchor: 'Re-anchor the conversation to the real objective',
}

const MODE_MIX: Record<ScaffoldingMode, SuggestionType[]> = {
  answer_now: ['answer', 'talking_point', 'question'],
  unblock: ['clarification', 'question', 'talking_point'],
  challenge_claim: ['fact_check', 'question', 'talking_point'],
  close_loop: ['question', 'clarification', 'talking_point'],
  re_anchor: ['talking_point', 'question', 'clarification'],
}

const PLAYBOOKS: Record<string, string[]> = {
  'Sales Call': [
    'Bias toward uncovering decision criteria, authority, implementation risk, and concrete next steps.',
    'Differentiate only with evidence tied to the buyer’s current objection; don’t pitch generically.',
    'If the buyer sounds polite but vague, assume hidden friction and surface it fast.',
    'If the buyer asks a direct question, lead with an answer or grounded talking point before asking another question.',
  ],
  'Job Interview': [
    'Bias toward high-signal examples, concrete ownership, and questions that reveal how the team actually operates.',
    'Avoid generic enthusiasm; help the participant show evidence or uncover the real working model.',
    'Use short story scaffolds when the best move is an answer, not abstract advice.',
    'If the interviewer asks a direct question, help the candidate answer first; do not burn the moment on a meta-question.',
  ],
  'Investor Pitch': [
    'Bias toward credibility, wedge clarity, defensibility, and what the current traction really proves.',
    'If a top-down claim appears, shift toward bottom-up evidence or a sharper segment definition.',
    'Keep the founder out of hand-wavy mode; move them toward concrete learning and strategic tradeoffs.',
    'If the investor asks a direct question, at least one top suggestion should help answer it directly before suggesting a question back.',
    'Do not ask the investor to define your wedge for you when they have already asked the founder directly.',
  ],
  'Customer Discovery': [
    'Bias toward truth-seeking over pitching: quantify pain, current workaround, owner, and priority.',
    'Treat polite interest as suspect until it is backed by time, cost, urgency, or real workaround behavior.',
    'If the problem lacks an owner, surface that as a buying-risk signal instead of ignoring it.',
  ],
  'Standup': [
    'Bias toward blockers, owners, dependencies, and what will slip if ambiguity stays unresolved.',
    'Escalate gently but specifically when a blocker is ownerless or deadline-sensitive.',
    'Prefer suggestions that create movement today, not generic process commentary.',
  ],
  '1:1': [
    'Bias toward turning vague feedback into something observable, specific, and time-bound.',
    'Preserve trust: probe directly without sounding defensive or overly apologetic.',
    'Prefer one clean clarifying question over multiple soft acknowledgements.',
  ],
  'Brainstorm': [
    'Bias toward decision criteria, convergence, and stopping idea-sprawl at the right moment.',
    'Use the facilitator’s role to re-anchor on what must be decided now versus parked for later.',
    'If the room is looping, surface the missing decision rule explicitly.',
  ],
  'Board Meeting': [
    'Bias toward strategy, leverage, capital allocation, and durable advantage — not update-mode detail.',
    'Translate operating noise into board-level tradeoffs the room can actually decide on.',
    'If a metric miss appears, connect it to a strategic decision rather than defending the metric alone.',
  ],
  'Team Review': [
    'Bias toward outcomes, named owners, recurring patterns, and interventions that change the system.',
    'Avoid vague accountability language; convert it into a concrete owner, date, and decision.',
    'If multiple issues point to one root cause, help the participant surface the pattern.',
  ],
}

function pickMode(chunks: TranscriptChunk[], ctx: MeetingContext): ScaffoldingMode {
  const signals = extractConversationSignals(chunks)
  const latest = chunks[chunks.length - 1]?.text.toLowerCase() ?? ''
  const goal = ctx.goal.toLowerCase()
  const prep = (ctx.prepNotes ?? '').toLowerCase()

  if (signals.questions.length > 0) return 'answer_now'
  if (signals.risks.length > 0 && (signals.commitments.length > 0 || /deadline|approve|decision|owner/.test(latest))) return 'unblock'
  if (signals.numericClaims.length > 0 || /similar|everyone|always|never|market|tam|percent|faster/.test(latest)) return 'challenge_claim'
  if (signals.commitments.length > 0 || /next step|follow up|by when|deadline/.test(goal + prep)) return 'close_loop'
  return 're_anchor'
}

function buildOpportunityLines(chunks: TranscriptChunk[]): string[] {
  const signals = extractConversationSignals(chunks)
  const candidates = [
    ...signals.questions.map((line) => `Open question: [${line.timestamp}] ${line.text}`),
    ...signals.risks.map((line) => `Risk / ambiguity: [${line.timestamp}] ${line.text}`),
    ...signals.numericClaims.map((line) => `Claim / number: [${line.timestamp}] ${line.text}`),
    ...signals.commitments.map((line) => `Commitment / next step: [${line.timestamp}] ${line.text}`),
  ]

  return candidates.slice(0, 4)
}

function buildAntiGoals(mode: ScaffoldingMode): string[] {
  switch (mode) {
    case 'answer_now':
      return ['Do not dodge the live question.', 'Do not give a generic answer without a proof structure.']
    case 'unblock':
      return ['Do not leave the blocker ownerless.', 'Do not restate the ambiguity without a next move.']
    case 'challenge_claim':
      return ['Do not accept the claim at face value.', 'Do not counter with invented evidence.']
    case 'close_loop':
      return ['Do not end with vague next steps.', 'Do not confuse activity with ownership.']
    case 're_anchor':
      return ['Do not keep brainstorming without a decision rule.', 'Do not drift away from the participant’s real goal.']
  }
}

export function buildDecisionScaffoldingSection(chunks: TranscriptChunk[], ctx: MeetingContext): string {
  const mode = pickMode(chunks, ctx)
  const playbook = PLAYBOOKS[ctx.meetingType] ?? [
    'Bias toward the highest-leverage next move, not a generic summary.',
    'Prefer questions or clarifications that change the quality of the conversation quickly.',
    'Stay grounded in what was actually said.',
  ]
  const opportunities = buildOpportunityLines(chunks)
  const mix = MODE_MIX[mode]
  const antiGoals = buildAntiGoals(mode)

  return [
    '## Decision scaffolding',
    `Primary mode: ${MODE_LABELS[mode]}`,
    `Recommended suggestion mix: ${mix.join(' → ')}`,
    ...(mode === 'answer_now' ? ['First suggestion bias: answer-like move first, follow-up question second.'] : []),
    'Meeting playbook:',
    ...playbook.map((line) => `- ${line}`),
    'Highest-leverage opportunities right now:',
    ...(opportunities.length > 0 ? opportunities.map((line) => `- ${line}`) : ['- none extracted yet']),
    'Anti-goals:',
    ...antiGoals.map((line) => `- ${line}`),
  ].join('\n')
}
