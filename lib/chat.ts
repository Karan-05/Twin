import Groq from 'groq-sdk'
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions'
import type { Message, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import type { QuestionCategory } from './contextSignals'
import {
  buildConversationSignalsSection,
  extractConversationSignals,
  extractPrimaryTopic,
  inferQuestionCategory,
  inferQuestionIntent,
  selectActionableQuestion,
} from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import { buildMeetingStateSection, deriveMeetingState } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const RESPONSE_GUARDRAILS = `You are a live meeting copilot. Never invent customer names, metrics, timelines, proof points, roles, or examples that are not explicitly present in the transcript or user message. If a stronger answer needs missing facts, use a fill-in-the-blank scaffold like [insert your real example] instead of fabricating.`
const CHAT_CONTEXT_CHAR_BUDGET = 4200
const DETAIL_CONTEXT_CHAR_BUDGET = 3600
const CHAT_MAX_TOKENS = 700
const DETAIL_MAX_TOKENS = 580

function isWeakDetailedAnswer(text: string, suggestionType: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (!/\*\*In short:\*\*/.test(trimmed)) return true
  if (/(?:\n|\r)\s*[-:]\s*$/.test(trimmed) || /[:\-–]\s*$/.test(trimmed)) return true

  const minimumLength = suggestionType === 'answer' || suggestionType === 'talking_point' ? 220 : 150
  if (trimmed.length < minimumLength) return true

  const bulletCount =
    (trimmed.match(/^\s*-\s/gm)?.length ?? 0) +
    (trimmed.match(/^>\s*"Say:/gm)?.length ?? 0) +
    (trimmed.match(/^\*\*Week [12]:\*\*/gm)?.length ?? 0)

  if ((suggestionType === 'answer' || suggestionType === 'talking_point') && !/Say:/i.test(trimmed)) return true
  if (bulletCount < (suggestionType === 'answer' || suggestionType === 'talking_point' ? 3 : 2)) return true

  return false
}

function buildKnowledgeSupportLine(topic: string, category: QuestionCategory): string {
  switch (category) {
    case 'location':
      return `- Start with the location itself on **${topic}**, then add why that location matters in this discussion.`
    case 'person':
      return `- Start with who **${topic}** is, then the role or context that makes them relevant here.`
    case 'timing':
      return `- Start with the timing itself on **${topic}**, then say what that timing changes in practice.`
    case 'definition':
      return `- Start with what **${topic}** is, then the practical way to think about it, then why it matters here.`
    case 'mechanism':
      return `- Walk it in order: input, processing, output, then the main constraint or bottleneck.`
    case 'comparison':
      return `- Compare **${topic}** on one axis first — quality, cost, speed, risk, or fit — before adding nuance.`
    case 'reason':
      return `- Focus on why **${topic}** matters, what changes because of it, and what decision it should influence.`
    case 'tradeoff':
      return `- Name the main trade-off on **${topic}**, then say which side matters more here.`
    case 'implementation':
      return `- Walk through the rollout: what happens first, where friction shows up, and what has to be true for it to work smoothly.`
    default:
      return `- Give the direct answer on **${topic}** first, then one implication that matters for this meeting.`
  }
}

function buildRoleAwareDetailFallback(
  topic: string,
  meetingContext: MeetingContext,
  openQuestion: { text: string; timestamp: string } | null,
  transcript: TranscriptChunk[],
  latest: TranscriptChunk | undefined,
  suggestionSay: string | undefined
): string[] | null {
  const hasConcreteSay = suggestionSay && !/\b(answer|question|rollout sequence)\b/i.test(suggestionSay)
  const liveText = `${openQuestion?.text ?? ''} ${latest?.text ?? ''} ${meetingContext.goal ?? ''} ${meetingContext.prepNotes ?? ''}`

  if (
    meetingContext.meetingType === 'Standup' &&
    /\b(blocked|blocker|owner|make the call|dependency|slip|ship|approve|approval|qa|legal|security|workaround)\b/i.test(liveText)
  ) {
    return [
      `**In short:** Surface the blocker owner directly, then name the decision or workaround that keeps the work moving this week.`,
      openQuestion ? `- Blocker question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Make the blocker concrete before the standup moves on.',
      '- Name what is blocked, who can actually make the call, and what slips if nobody acts today.',
      '- Separate the longer-term owner question from the immediate workaround so the team leaves with a path either way.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: The blocker is not just the task, it is the missing decision owner. We should name who can make the call today, and if that person is unavailable, agree on the workaround that keeps us moving this week."',
      '- [ ] Next step to lock: owner, unblock action, and the date or check-in when the team will know this is cleared.',
    ]
  }

  if (
    meetingContext.meetingType === 'Team Review' &&
    /\b(broke|broken|repair|owner|handoff|regression|incident|root cause|fix)\b/i.test(liveText)
  ) {
    return [
      `**In short:** Turn the review into one clean repair answer: what broke, why it broke, who owns the fix, and how recurrence gets reduced.`,
      openQuestion ? `- Repair question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Do not let the room blur cause, owner, and fix into one vague update.',
      '- Start with the failure mode itself, then name the ownership gap or handoff problem that allowed it through.',
      '- End with the concrete repair path and the one process change that should reduce recurrence next time.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: What broke was the handoff, not just the final output. The fix is to assign one owner for the repair now, and then tighten the review step that should have caught it earlier."',
      '- [ ] Next step to lock: owner, repair deadline, and the review checkpoint that prevents the same class of failure.',
    ]
  }

  if (
    meetingContext.meetingType === 'Sales Call' &&
    /\b(onboarding|rollout|implementation|faster than|faster|than the others|why your onboarding)\b/i.test(liveText)
  ) {
    return [
      `**In short:** Answer the onboarding objection directly by naming why the rollout is faster, what the first value point is, and which dependency could still slow it down.`,
      openQuestion ? `- Buyer objection: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- A speed objection needs a concrete rollout answer, not a generic reassurance.',
      '- Lead with the reason the rollout is faster: fewer moving pieces, a narrower initial scope, or less custom integration work than the alternatives.',
      '- Then say what the customer sees first, who needs to be involved, and which dependency would actually extend the timeline.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: Our onboarding is faster because we start with a narrower path to first value instead of a full custom rollout. The first milestone is a working setup with your core workflow, and the main thing that changes timing is how quickly we get the right stakeholder and data access lined up."',
      '- [ ] Next step to lock: confirm the first workflow, required stakeholders, and the dependency that would decide the timeline.',
    ]
  }

  if (
    meetingContext.meetingType === 'Sales Call' &&
    /\b(first two weeks|implementation timeline|move forward|moved forward|implementation)\b/i.test(openQuestion?.text ?? '') &&
    /\b(bilingual|operations|ops|finance|approval|q4)\b/i.test(`${meetingContext.prepNotes ?? ''} ${latest?.text ?? ''} ${openQuestion?.text ?? ''}`)
  ) {
    return [
      `**In short:** Answer the rollout sequence directly, then tie it to the hidden stakeholder concern before locking the next step.`,
      openQuestion ? `- Rollout question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Give a direct implementation sequence, not a vague reassurance.',
      '- **Week 1:** run the kickoff with the operations stakeholders, map the current workflow, and confirm what stays lightweight so this does not become another long migration.',
      '- **Week 2:** review the first working path with operations and finance, surface any approval blocker, and decide whether this is concrete enough to prioritize now instead of waiting for **Q4**.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: Week 1 is a kickoff with operations to map the current workflow and keep the rollout lightweight. Week 2 is a review of the first working path with operations and finance so we can decide now, not wait for Q4."',
      '- [ ] Next step to lock: confirm who from operations and finance needs to see that walkthrough, and by when.',
    ]
  }

  if (meetingContext.meetingType === 'Investor Pitch') {
    return [
      `**In short:** Answer the strategic thesis on **${topic}** directly, then tie it to the strongest proof or friction in the transcript.`,
      openQuestion ? `- Open investor question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Name where you win fastest before broad market framing.',
      '- Lead with the wedge or fastest-winning segment first, then explain what the current traction or security-review friction proves about that segment.',
      '- Separate the incumbent or defensibility concern from the wedge answer so you do not blur them into one generic strategy paragraph.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: The wedge here is the segment where the current traction and friction show we win fastest — and the strategic question is how that expands, not how large the whole market sounds."`,
      '- [ ] Next step to lock: name the proof point or open risk the investor should evaluate next.',
    ]
  }

  if (meetingContext.meetingType === 'Board Meeting') {
    const migrationLine = transcript.find((chunk) => /\bmigrations?\b|\broadmap\b/i.test(chunk.text))
    const growthLine = transcript.find((chunk) => /\bupsell\b|\bpackaging\b|\badoption\b/i.test(chunk.text))
    const leverageLine = transcript.find((chunk) => /\bdurable leverage\b/i.test(chunk.text))

    return [
      `**In short:** Answer the board-level trade-off directly, then tie it to leverage, capital allocation, and the unresolved growth decision.`,
      leverageLine ? `- Board frame: "${leverageLine.text}" [${leverageLine.timestamp}]` : (latest ? `- Board context: "${latest.text}" [${latest.timestamp}]` : '- Keep the response at board altitude, not update mode.'),
      migrationLine
        ? `- Strategic cost: "${migrationLine.text}" [${migrationLine.timestamp}]`
        : '- Name the strategic trade-off first, then what it is costing on the product side.',
      growthLine
        ? `- Growth thread still open: "${growthLine.text}" [${growthLine.timestamp}]`
        : '- Tie the allocation trade-off to the unresolved growth or packaging decision the board actually cares about.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: The trade-off is that migrations protected renewals, but they also slowed the platform and left the AI upsell story under-packaged. The board decision is whether that is a short-term bridge or the way we are going to keep operating."`,
      '- [ ] Next step to lock: frame the trigger, date, or metric that tells the board when this allocation should change.',
    ]
  }

  if (meetingContext.meetingType === '1:1') {
    return [
      `**In short:** Respond on **${topic}** with one respectful line, then ask for one example, the pattern behind it, and the target for the stated time window.`,
      openQuestion ? `- Feedback moment: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Treat vague feedback as something to make observable, not something to absorb passively.',
      '- Keep the tone calm and direct: acknowledge the feedback, ask for one recent example, then ask what better should look like over the next month or stated window.',
      '- If multiple stakeholders were named, ask which pattern matters most and where it showed up most clearly.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: That makes sense — can you give me one concrete example of where this showed up recently, and what better would look like over the next month?"',
      '- [ ] Next step to lock: confirm the behavior to change, who will notice it, and when you should check back in.',
    ]
  }

  if (
    /\bllm|large language model|transformer|tokenization|tokenisation|embedding|embeddings|attention|next token\b/i.test(liveText)
  ) {
    return [
      `**In short:** Explain the system in order, then separate training from inference so the answer feels concrete instead of mystical.`,
      openQuestion ? `- Technical question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Use a real sequence, not abstract AI marketing language.',
      '- Walk it as a pipeline: text is tokenized, tokens are turned into embeddings with positional information, attention layers update those representations using surrounding context, and decoding produces one next token at a time.',
      '- Then separate training from inference: training is where the weights learned statistical patterns, inference is the live pass where the model applies those learned weights to the current prompt.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: An LLM works in a sequence. It tokenizes the input, maps those tokens into embeddings, uses transformer attention to mix in context across the sequence, and then predicts the next token repeatedly until it completes the answer. Training is the earlier step that taught the model those weights; inference is the live step using them on your prompt."',
      '- [ ] Next step to lock: ask whether they want the training loop, the attention mechanism, or the real-time serving stack next.',
    ]
  }

  if (/\barchitecture|pipeline|workflow|integration|system|platform|agent\b/i.test(liveText)) {
    return [
      `**In short:** Explain the system as a concrete flow: input, core processing, output, and the main constraint that shapes real-world behavior.`,
      openQuestion ? `- System question: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- Make the path legible before adding nuance.',
      '- Start with what comes in, then what transforms it, then what the user or downstream system actually gets out.',
      '- End with the bottleneck or trade-off that matters in practice: latency, accuracy, cost, reliability, or integration complexity.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: The clearest way to explain ${topic} is the flow from input to output, plus the main constraint that shapes the real trade-offs in production."`,
      '- [ ] Next step to lock: ask whether they want the high-level flow, the bottleneck, or the implementation detail next.',
    ]
  }

  return null
}

function buildLocalChatFallback(
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext,
  userMessage: string
): string {
  const signals = extractConversationSignals(transcript.slice(-8))
  const latest = transcript[transcript.length - 1]
  const topic = extractPrimaryTopic(transcript.slice(-8), `${meetingContext.goal} ${userMessage}`) || signals.topics.slice(0, 2).join(' / ') || meetingContext.goal || 'current topic'
  const question = selectActionableQuestion(transcript.slice(-8), meetingContext)
  const category = inferQuestionCategory(question?.text ?? userMessage)
  const questionIntent = inferQuestionIntent(question?.text ?? userMessage, meetingContext)

  if (questionIntent !== 'meeting_coaching') {
    return [
      `**In short:** ${questionIntent === 'direct_answer'
        ? 'Answer the live question on **' + topic + '** directly first — then make it useful for the meeting.'
        : 'Answer the knowledge question on **' + topic + '** directly first — then bridge it back to the meeting.'}`,
      question ? `- Open question: "${question.text}" [${question.timestamp}]` : `- Topic: **${topic}**`,
      buildKnowledgeSupportLine(topic, category),
      questionIntent === 'direct_answer'
        ? '- If the answer depends on the participant’s experience, timing, or constraints, make that dependency explicit instead of bluffing.'
        : '- If the fact depends on a version, date, configuration, or policy, state that variable explicitly instead of bluffing.',
      `- Your question: "${userMessage}"`,
      '- Groq is temporarily rate-limited, so this is a local answer-first fallback rather than a full model answer.',
    ].join('\n')
  }

  const genericCategoryLine = (() => {
    switch (category) {
      case 'definition':
        return '- Answer it in order: what it is, how to think about it practically, and why it matters in this conversation.'
      case 'mechanism':
        return '- Answer it as a sequence: input, processing, output, and the main trade-off or bottleneck.'
      case 'comparison':
        return '- Compare it on one axis first — quality, cost, speed, risk, or fit — before adding nuance.'
      case 'reason':
        return '- Focus on why it matters, what changes because of it, and which decision it should influence.'
      case 'tradeoff':
        return '- Name the main trade-off explicitly, then say which side matters more here.'
      case 'implementation':
        return '- Walk through what happens first, where friction shows up, and what must be true for it to go smoothly.'
      default:
        return '- Give the direct answer first, then one implication that matters for this meeting.'
    }
  })()

  const lines = [
    '**In short:** Use the latest thread to move the conversation on **' + topic + '** right now.',
  ]

  if (latest) {
    lines.push(`- Latest transcript anchor: "${latest.text}" [${latest.timestamp}]`)
  }

  if (question) {
    lines.push(`- Open question still hanging: "${question.text}" [${question.timestamp}]`) 
  }

  lines.push(genericCategoryLine)
  lines.push(`- Your question: "${userMessage}"`)
  lines.push('- Groq is temporarily rate-limited, so this is a local fallback. Ask one clarifying question or lock one next step while the quota window resets.')
  return lines.join('\n')
}

function buildLocalDetailedFallback(
  suggestionTitle: string,
  suggestionType: string,
  suggestionDetail: string,
  suggestionSay: string | undefined,
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext
): string {
  const signals = extractConversationSignals(transcript.slice(-8))
  const latest = transcript[transcript.length - 1]
  const openQuestion = selectActionableQuestion(transcript.slice(-8), meetingContext)
  const riskyItem = signals.numericClaims[0] || signals.risks[0]
  const commitment = signals.commitments[0]
  const goalClause = meetingContext.goal ? `**${meetingContext.goal}**` : 'your stated goal'
  const extractedTopic = extractPrimaryTopic(transcript.slice(-8), `${meetingContext.goal} ${suggestionTitle}`)
  const category = inferQuestionCategory(openQuestion?.text ?? suggestionTitle)
  const questionIntent = inferQuestionIntent(openQuestion?.text ?? suggestionTitle, meetingContext)
  const knowledgeQuestion = questionIntent !== 'meeting_coaching'
  const topic = category === 'implementation'
    ? 'rollout'
    : extractedTopic || 'current topic'

  const anchor =
    suggestionType === 'answer' || suggestionType === 'question' ? openQuestion ?? latest
    : suggestionType === 'fact_check' ? riskyItem ?? latest
    : suggestionType === 'clarification' ? commitment ?? riskyItem ?? latest
    : latest

  const evidenceLine = anchor
    ? `**Evidence:** "${anchor.text}" [${anchor.timestamp}]`
    : '**Evidence:** Thin transcript — using suggestion framing.'

  const roleAware = buildRoleAwareDetailFallback(topic, meetingContext, openQuestion, transcript.slice(-8), latest, suggestionSay)
  if (roleAware) {
    return [evidenceLine, '', ...roleAware].join('\n')
  }

  if ((suggestionType === 'answer' || suggestionType === 'talking_point') && knowledgeQuestion) {
    return [
      evidenceLine,
      '',
      `**In short:** Answer the question on **${topic}** itself first — then bridge it back to why it matters here.`,
      buildKnowledgeSupportLine(topic, category),
      questionIntent === 'domain_knowledge'
        ? '- Treat it as a domain or product question: say what it is for, where it fits, and which variable would change the recommendation.'
        : questionIntent === 'direct_answer'
          ? '- Treat it as a direct answer moment: answer plainly, then add the one concrete implication, dependency, or next move that makes the answer useful.'
        : '- If the answer depends on scale, version, date, configuration, or policy, state that dependency plainly instead of bluffing.',
      suggestionSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: The direct answer on ${topic} comes first — then I can connect it to the implication that matters most here."`,
      `- [ ] Next step to lock: confirm whether they want more depth, a comparison, or the practical implication next.`,
    ].join('\n')
  }

  let inShort: string
  let bullets: string[]

  switch (suggestionType) {
    case 'answer':
      inShort = 'Give a direct, high-signal answer — not a summary of the question.'
      bullets = [
        openQuestion
          ? `- Open question: "${openQuestion.text}" [${openQuestion.timestamp}]`
          : `- Anchor on **${suggestionTitle}** — your most concrete fact or credential on this topic.`,
        category === 'definition'
          ? '- Structure: answer what it is, then the practical way to think about it, then why it matters here.'
          : category === 'mechanism'
            ? '- Structure: answer as a path — input, processing, output, then the main trade-off or bottleneck.'
            : category === 'comparison'
              ? '- Structure: pick one comparison axis first, answer on that axis, then add nuance only if needed.'
              : '- Structure: direct answer first, one concrete implication second, one next move third.',
        suggestionSay
          ? `> "Say: ${suggestionSay}"`
          : category === 'definition'
          ? `> "Say: Let me answer ${topic} directly: first what it is, then how to think about it practically, then why it matters here."`
          : category === 'mechanism'
            ? `> "Say: The clearest way to explain ${topic} is the path from input to output, plus the main trade-off that shapes the design."`
            : category === 'comparison'
              ? `> "Say: The cleanest way to compare ${topic} is on one axis first — quality, cost, speed, risk, or fit — then we can add nuance."`
              : `> "Say: Let me answer that directly, then make it concrete with the one implication that matters most here."`,
        `- [ ] Next step to lock: connect this answer to ${goalClause} with a named owner and timing.`,
      ]
      break

    case 'question':
      inShort = 'Ask this now — say it cleanly and wait. Don\'t explain the question.'
      bullets = [
        `- Say: **${suggestionTitle}** — in one direct sentence ending with a question mark.`,
        suggestionSay
          ? `> "Say: ${suggestionSay}"`
          : `> "Say: ${suggestionTitle.endsWith('?') ? suggestionTitle : `${suggestionTitle}?`}"`,
        '- A strong reply: specific and opinionated — gives you something to act on.',
        '- A weak reply: vague or deflecting — push once: "Can you be more specific?"',
        openQuestion && openQuestion.text !== suggestionTitle
          ? `- Relates to the open question: "${openQuestion.text}" [${openQuestion.timestamp}]`
          : `- [ ] Next step: what does the answer change about ${goalClause}?`,
      ]
      break

    case 'fact_check':
      inShort = 'Challenge this claim politely but immediately — before the room anchors on it.'
      bullets = [
        riskyItem
          ? `- Claim to challenge: "${riskyItem.text}" [${riskyItem.timestamp}]`
          : '- Name the exact claim, then ask for the source or assumption behind it.',
        `> "Say: That's an important data point — what's the assumption or source behind it?"`,
        '- A strong reply: cites a real source or baseline.',
        '- A weak reply: signals the number is softer than it sounds — push once more.',
        '- [ ] Next step: if the number holds, build on it. If not, recalibrate the plan around it.',
      ]
      break

    case 'clarification':
      inShort = 'Get this defined before the conversation moves on — vagueness here costs time later.'
      bullets = [
        `- What's still undefined: **${suggestionTitle}**`,
        suggestionSay
          ? `> "Say: ${suggestionSay}"`
          : `> "Say: Before we move on — can we pin down the specific thing that is still undefined here so it does not create confusion later?"`,
        '- Downstream consequence: without a clear owner, criterion, or decision rule, this will resurface and cost more time.',
        commitment
          ? `- Existing commitment to pin down: "${commitment.text}" [${commitment.timestamp}]`
          : `- [ ] Next step: name the owner + the exact decision needed + a hard deadline.`,
      ]
      break

    case 'talking_point':
      inShort = 'Contribute this perspective now to shift the conversation toward a concrete decision.'
      bullets = [
        latest ? `- Build on: "${latest.text}" [${latest.timestamp}]` : '- Lead with a concrete fact or credential, not a general opinion.',
        '- Frame: **[your key point]** → **[why it matters right now]** → **[what action it implies]**',
        suggestionSay
          ? `> "Say: ${suggestionSay}"`
          : `> "Say: The key thing to add here is the practical implication that changes what we should do next."`,
        `- [ ] Next step: connect this to ${goalClause} and propose one concrete action before moving on.`,
      ]
      break

    default:
      inShort = `Act on **${suggestionTitle}** — your next move.`
      bullets = [
        latest ? `- Most recent context: "${latest.text}" [${latest.timestamp}]` : '- Use the current discussion as your anchor.',
        `- ${suggestionDetail.slice(0, 130)}${suggestionDetail.length > 130 ? '…' : ''}`,
        `- [ ] Next step: name the owner, action, and timing before moving on.`,
      ]
  }

  return [evidenceLine, '', `**In short:** ${inShort}`, ...bullets].join('\n')
}


function buildTranscriptContext(transcript: TranscriptChunk[], maxChunks = 0, maxChars = CHAT_CONTEXT_CHAR_BUDGET): string {
  const chunks = maxChunks > 0 ? transcript.slice(-maxChunks) : transcript
  if (chunks.length === 0) return '(no transcript yet)'

  const selected: string[] = []
  let usedChars = 0

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const line = `[${chunks[index].timestamp}] ${chunks[index].text}`
    if (selected.length > 0 && usedChars + line.length > maxChars) break
    selected.unshift(line)
    usedChars += line.length
  }

  const omitted = chunks.length - selected.length
  return omitted > 0
    ? `(Older transcript trimmed for latency/token budget; ${omitted} earlier segments omitted.)\n${selected.join('\n')}`
    : selected.join('\n')
}

function interpolateContext(template: string, ctx: MeetingContext): string {
  const meetingType = ctx.meetingType || 'General Meeting'
  const userRole = ctx.userRole || 'Attendee'
  const userGoalSection = ctx.goal ? `\nGoal: ${ctx.goal}` : ''
  const meetingPrepSection = ctx.prepNotes ? `\nMeeting prep: ${ctx.prepNotes}` : ''
  const proofPointsSection = ctx.proofPoints ? `\nProof points I can use: ${ctx.proofPoints}` : ''
  return template
    .replace(/{meeting_type}/g, meetingType)
    .replace(/{user_role}/g, userRole)
    .replace(/{user_goal_section}/g, userGoalSection)
    .replace(/{meeting_prep_section}/g, meetingPrepSection)
    .replace(/{proof_points_section}/g, proofPointsSection)
}

function buildPrompt(
  template: string,
  transcriptContext: string,
  signalChunks: TranscriptChunk[],
  meetingContext: MeetingContext,
  extraReplacements: Record<string, string> = {}
): string {
  const conversationSignalsSection = buildConversationSignalsSection(signalChunks)
  const decisionScaffoldingSection = buildDecisionScaffoldingSection(signalChunks, meetingContext)
  const meetingStateSection = buildMeetingStateSection(deriveMeetingState(signalChunks, meetingContext))
  let withTranscript = template
    .replace('{full_transcript}', transcriptContext)
    .replace(/{conversation_signals_section}/g, conversationSignalsSection)
    .replace(/{decision_scaffolding_section}/g, decisionScaffoldingSection)
    .replace(/{meeting_state_section}/g, meetingStateSection)

  for (const [key, value] of Object.entries(extraReplacements)) {
    withTranscript = withTranscript.replace(new RegExp(`{${key}}`, 'g'), value)
  }

  const withInjectedSignals = template.includes('{conversation_signals_section}')
    ? withTranscript
    : `${withTranscript}\n\n${conversationSignalsSection}`

  const withInjectedScaffolding = template.includes('{decision_scaffolding_section}')
    ? withInjectedSignals
    : `${withInjectedSignals}\n\n${decisionScaffoldingSection}`

  const withInjectedMeetingState = template.includes('{meeting_state_section}')
    ? withInjectedScaffolding
    : `${withInjectedScaffolding}\n\n${meetingStateSection}`

  return interpolateContext(withInjectedMeetingState, meetingContext)
}

export async function* streamChatResponse(
  messages: Message[],
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' }
): AsyncGenerator<string> {
  const fullContext = buildTranscriptContext(transcript, 0, CHAT_CONTEXT_CHAR_BUDGET)
  const signalChunks = transcript.slice(-Math.max(settings.suggestionContextWindow + 2, 8))
  const systemContent = buildPrompt(settings.chatSystemPrompt, fullContext, signalChunks, meetingContext)
  const requestMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${RESPONSE_GUARDRAILS}\n\n${systemContent}` },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]
  const promptText = requestMessages.map((message) => message.content).join('\n\n')

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  let stream
  try {
    stream = await withGroqTextBudget(promptText, CHAT_MAX_TOKENS, 'high', () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: requestMessages,
      stream: true,
      temperature: 0.35,
      max_tokens: CHAT_MAX_TOKENS,
    }))
  } catch {
    yield buildLocalChatFallback(transcript, meetingContext, messages[messages.length - 1]?.content ?? '')
    return
  }

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}

export async function* streamDetailedAnswer(
  suggestionTitle: string,
  suggestionType: string,
  suggestionDetail: string,
  suggestionSay: string | undefined,
  suggestionWhyNow: string | undefined,
  suggestionListenFor: string | undefined,
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' }
): AsyncGenerator<string> {
  const detailChunks = settings.detailContextWindow > 0 ? transcript.slice(-settings.detailContextWindow) : transcript
  const fullContext = buildTranscriptContext(transcript, settings.detailContextWindow, DETAIL_CONTEXT_CHAR_BUDGET)
  const anchorQuestion = selectActionableQuestion(transcript, meetingContext)

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  const prompt = buildPrompt(
    settings.clickDetailPrompt
      .replace('{suggestion_title}', suggestionTitle)
      .replace('{suggestion_detail}', suggestionDetail)
      .replace('{suggestion_say}', suggestionSay ?? 'none')
      .replace('{suggestion_why_now}', suggestionWhyNow ?? 'none')
      .replace('{suggestion_listen_for}', suggestionListenFor ?? 'none')
      .replace('{suggestion_anchor}', anchorQuestion ? `"${anchorQuestion.text}" [${anchorQuestion.timestamp}]` : 'none'),
    fullContext,
    detailChunks,
    meetingContext,
    {
      suggestion_type: suggestionType,
      suggestion_say: suggestionSay ?? 'none',
      suggestion_why_now: suggestionWhyNow ?? 'none',
      suggestion_listen_for: suggestionListenFor ?? 'none',
      suggestion_anchor: anchorQuestion ? `"${anchorQuestion.text}" [${anchorQuestion.timestamp}]` : 'none',
    }
  )

  const promptText = `${RESPONSE_GUARDRAILS}\n\n${prompt}`
  let stream
  try {
    stream = await withGroqTextBudget(promptText, DETAIL_MAX_TOKENS, 'high', () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: RESPONSE_GUARDRAILS },
        { role: 'user', content: prompt },
      ],
      stream: true,
      temperature: 0.25,
      max_tokens: DETAIL_MAX_TOKENS,
    }))
  } catch (err) {
    console.error('[streamDetailedAnswer] Groq failed, using local fallback:', err)
    yield buildLocalDetailedFallback(suggestionTitle, suggestionType, suggestionDetail, suggestionSay, transcript, meetingContext)
    return
  }

  let fullResponse = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) fullResponse += delta
  }

  if (isWeakDetailedAnswer(fullResponse, suggestionType)) {
    console.warn('[streamDetailedAnswer] Groq returned weak/incomplete detail, using local fallback instead')
    yield buildLocalDetailedFallback(suggestionTitle, suggestionType, suggestionDetail, suggestionSay, transcript, meetingContext)
    return
  }

  yield fullResponse.trim()
}
