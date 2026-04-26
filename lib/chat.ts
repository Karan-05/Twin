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
import { buildSecondBrainBriefSection, deriveSecondBrainBrief } from './secondBrain'

const RESPONSE_GUARDRAILS = `You are a live meeting copilot. Never invent customer names, metrics, timelines, proof points, roles, or examples that are not explicitly present in the transcript or user message. If a stronger answer needs missing facts, use a fill-in-the-blank scaffold like [insert your real example] instead of fabricating.`
const CHAT_CONTEXT_CHAR_BUDGET = 4200
const DETAIL_CONTEXT_CHAR_BUDGET = 3600
const CHAT_MAX_TOKENS = 700
const DETAIL_MAX_TOKENS = 580

function isWeakDetailedAnswer(
  text: string,
  suggestionType: string,
  transcript: TranscriptChunk[],
  meetingContext: MeetingContext
): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (!/\*\*In short:\*\*/.test(trimmed)) return true
  if (/(?:\n|\r)\s*[-:]\s*$/.test(trimmed) || /[:\-–]\s*$/.test(trimmed)) return true
  if ((trimmed.match(/"/g)?.length ?? 0) % 2 === 1) return true

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

function buildKnowledgeOpeningLine(
  topic: string,
  category: QuestionCategory,
  sourceText: string
): string {
  const lower = sourceText.toLowerCase()

  if (/\bllm\b|\blarge language model\b/.test(lower)) {
    return 'An LLM tokenizes the prompt, maps those tokens into embeddings, uses attention to relate each token to the rest of the context, and then predicts the next token repeatedly until it forms a full answer.'
  }

  switch (category) {
    case 'definition':
      return `${topic} is best understood by stating what it is, what job it does, and why that matters here.`
    case 'mechanism':
      return `${topic} works as a flow from input, to representation, to processing, to output, with one main constraint shaping the result.`
    case 'comparison':
      return `The cleanest way to compare ${topic} is on one axis first, then explain what that difference changes in practice.`
    case 'tradeoff':
      return `The important thing about ${topic} is the trade-off it forces and which side of that trade-off matters more here.`
    case 'implementation':
      return `${topic} becomes concrete when you name the first step, the friction point, and the dependency that decides whether rollout stays smooth.`
    default:
      return `The direct answer on ${topic} should come first, followed by the implication that changes the real decision.`
  }
}

function buildKnowledgeExpansionBullets(
  topic: string,
  category: QuestionCategory,
  sourceText: string
): string[] {
  const lower = sourceText.toLowerCase()

  if (/\bllm\b|\blarge language model\b/.test(lower)) {
    return [
      '- Tokenization breaks text into model-readable pieces, which is how the system turns a sentence into units it can process.',
      '- Embeddings turn those tokens into vectors, and attention is what lets the model weigh which earlier words matter for the next prediction.',
      '- Training is when the model learns the weights by predicting missing or next tokens across massive text corpora; inference is the live moment when those learned weights are used to answer a prompt.',
      '- The model does not “understand” like a human does; it builds useful statistical context from patterns in the prompt and then decodes one next token at a time.',
    ]
  }

  switch (category) {
    case 'definition':
      return [
        `- Start with what ${topic} is in plain language, then say what job it is actually doing in the system or workflow.`,
        '- Add the practical implication that helps the room reason about it instead of only naming the concept.',
      ]
    case 'mechanism':
      return [
        '- Walk through the stages in order so the room sees how the pieces connect instead of hearing isolated jargon.',
        '- End on the bottleneck or failure mode, because that is usually what makes the explanation useful in a real meeting.',
      ]
    case 'comparison':
      return [
        '- Pick one comparison axis first so the answer does not sprawl into a list of disconnected pros and cons.',
        '- Then say what that axis changes in the decision the room is actually making.',
      ]
    case 'tradeoff':
      return [
        '- State both sides of the trade-off clearly so the room can tell what is gained and what is being sacrificed.',
        '- Then say which side matters more in this exact context and why.',
      ]
    case 'implementation':
      return [
        '- Name the first operational step, the first point of friction, and the dependency that usually determines whether execution stays on schedule.',
        '- That turns the answer from abstract advice into something the room can actually sequence.',
      ]
    default:
      return [
        '- Answer plainly first, then sharpen the consequence or dependency that changes what the room should do next.',
      ]
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

  // If the question is about a topic (technical, domain, general knowledge) rather than
  // meeting navigation, defer to the generic knowledge path — no hardcoded topic check needed.
  const questionText = openQuestion?.text ?? latest?.text ?? topic
  const questionIntent = inferQuestionIntent(questionText, meetingContext)
  if (questionIntent === 'technical_knowledge' || questionIntent === 'domain_knowledge' || questionIntent === 'general_knowledge') {
    return null
  }

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
    meetingContext.meetingType === 'Brainstorm' &&
    /\b(brainstorm|loop|looping|narrow|decision|deciding|criteria|options)\b/i.test(liveText)
  ) {
    return [
      `**In short:** Stop adding options and set the decision rule now so the room can converge without killing momentum.`,
      openQuestion ? `- Live thread: "${openQuestion.text}" [${openQuestion.timestamp}]` : '- The room is drifting because more ideas are arriving faster than decisions.',
      '- Name the tension explicitly: this week needs **one testable idea**, while the stakeholders are split on **speed versus polish**.',
      '- Set the frame in one sentence: judge the options against activation impact, differentiation, support cost, and what can be tested inside two weeks.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : '> "Say: Let’s stop generating options for a moment and choose the decision rule first. We need one idea we can test this week, so let’s judge these on activation impact, differentiation, support cost, and whether we can ship a credible version in two weeks."',
      '- [ ] Next step to lock: choose the single option to test this week and name the owner before the brainstorm ends.',
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
    const boardSignals = extractConversationSignals(transcript)
    const boardRisk = boardSignals.risks[0] ?? boardSignals.numericClaims[0]
    const boardCommitment = boardSignals.commitments[0]
    const boardQuestion = openQuestion ?? boardSignals.questions[0]

    return [
      `**In short:** Answer the board-level trade-off directly on **${topic}**, then tie it to capital allocation, the open risk, and the unresolved strategic decision.`,
      boardQuestion ? `- Board question: "${boardQuestion.text}" [${boardQuestion.timestamp}]` : (latest ? `- Board context: "${latest.text}" [${latest.timestamp}]` : '- Keep the response at board altitude, not update mode.'),
      boardRisk
        ? `- Risk or claim on the table: "${boardRisk.text}" [${boardRisk.timestamp}]`
        : '- Name the strategic trade-off first — what it costs on the product or financial side.',
      boardCommitment
        ? `- Commitment to anchor on: "${boardCommitment.text}" [${boardCommitment.timestamp}]`
        : '- Tie the allocation trade-off to the unresolved strategic decision the board actually cares about.',
      hasConcreteSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: The board-level trade-off here is between [the cost of the current path] and [the growth option we are not fully pursuing]. The decision is whether the current allocation is a temporary bridge or the way we are going to keep operating."`,
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
  const secondBrainBrief = deriveSecondBrainBrief(transcript.slice(-8), meetingContext)

  // Summary / recap queries — build structured output from signals, no rate-limit mention
  const isSummaryQuery = /summar(y|ize|ise|ised|ized)|recap|key\s+(points?|takeaways?|decisions?)/i.test(userMessage)
  if (isSummaryQuery) {
    const lines: string[] = [`**Meeting Summary**`, `**Topic:** ${topic}`]

    const observations = [
      ...signals.numericClaims.slice(0, 2).map((c) => `- ${c.text} [${c.timestamp}]`),
      ...signals.risks.slice(0, 1).map((r) => `- Risk flagged: ${r.text} [${r.timestamp}]`),
    ]
    if (observations.length > 0) {
      lines.push('\n**Key Observations:**')
      lines.push(...observations)
    }

    const openQs = signals.questions.slice(0, 3)
    if (openQs.length > 0) {
      lines.push('\n**Open Questions:**')
      for (const q of openQs) lines.push(`- ${q.text} [${q.timestamp}]`)
    }

    const commitments = signals.commitments.slice(0, 3)
    if (commitments.length > 0) {
      lines.push('\n**Commitments / Next Steps:**')
      for (const c of commitments) lines.push(`- ${c.text} [${c.timestamp}]`)
    }

    if (transcript.length < 3) {
      lines.push('\n*(Not enough transcript yet — keep recording for a fuller summary.)*')
    }

    return lines.join('\n')
  }

  if (questionIntent !== 'meeting_coaching') {
    return [
      `**In short:** ${questionIntent === 'direct_answer'
        ? 'Answer the live question on **' + topic + '** directly first — then make it useful for the meeting.'
        : 'Answer the knowledge question on **' + topic + '** directly first — then bridge it back to the meeting.'}`,
      question ? `- Open question: "${question.text}" [${question.timestamp}]` : `- Topic: **${topic}**`,
      secondBrainBrief.tension
        ? `- Read of the room: ${secondBrainBrief.tension}`
        : '- Read of the room: this answer needs to be useful in the actual conversation, not just correct in the abstract.',
      buildKnowledgeSupportLine(topic, category),
      questionIntent === 'direct_answer'
        ? '- If the answer depends on the participant’s experience, timing, or constraints, make that dependency explicit instead of bluffing.'
        : '- If the fact depends on a version, date, configuration, or policy, state that variable explicitly instead of bluffing.',
      `- Your question: "${userMessage}"`,
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

  if (secondBrainBrief.bestMove) {
    lines.push(`- Best move now: ${secondBrainBrief.bestMove}`)
  }

  lines.push(genericCategoryLine)
  lines.push(`- Your question: "${userMessage}"`)
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
  const secondBrainBrief = deriveSecondBrainBrief(transcript.slice(-8), meetingContext)

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
    const sourceText = `${openQuestion?.text ?? ''} ${suggestionTitle} ${suggestionDetail} ${meetingContext.goal ?? ''}`
    const openingLine = buildKnowledgeOpeningLine(topic, category, sourceText)
    const expansionBullets = buildKnowledgeExpansionBullets(topic, category, sourceText)
    return [
      evidenceLine,
      '',
      `**In short:** ${openingLine}`,
      secondBrainBrief.tension
        ? `- Read of the room: ${secondBrainBrief.tension}`
        : '- Read of the room: the answer needs to help the participant in the live conversation, not just explain the topic.',
      ...expansionBullets,
      questionIntent === 'domain_knowledge'
        ? '- Treat it as a domain or product question: say what it is for, where it fits, and which variable would change the recommendation.'
        : questionIntent === 'direct_answer'
          ? '- Treat it as a direct answer moment: answer plainly, then add the one concrete implication, dependency, or next move that makes the answer useful.'
          : '- If the answer depends on scale, version, date, configuration, or policy, state that dependency plainly instead of bluffing.',
      suggestionSay
        ? `> "Say: ${suggestionSay}"`
        : `> "Say: ${openingLine}"`,
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
        secondBrainBrief.tension
          ? `- Read of the room: ${secondBrainBrief.tension}`
          : '- Read of the room: answer first, then make the consequence clear.',
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
  extraReplacements: Record<string, string> = {},
  priorMeetingContext?: string
): string {
  const conversationSignalsSection = buildConversationSignalsSection(signalChunks)
  const decisionScaffoldingSection = buildDecisionScaffoldingSection(signalChunks, meetingContext)
  const meetingState = deriveMeetingState(signalChunks, meetingContext)
  const meetingStateSection = buildMeetingStateSection(meetingState)
  const secondBrainBriefSection = buildSecondBrainBriefSection(signalChunks, meetingContext, meetingState)
  let withTranscript = template
    .replace('{full_transcript}', transcriptContext)
    .replace(/{conversation_signals_section}/g, conversationSignalsSection)
    .replace(/{decision_scaffolding_section}/g, decisionScaffoldingSection)
    .replace(/{second_brain_brief_section}/g, secondBrainBriefSection)
    .replace(/{prior_meeting_context_section}/g, priorMeetingContext ?? '')
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

  const withInjectedSecondBrain = template.includes('{second_brain_brief_section}')
    ? withInjectedMeetingState
    : `${withInjectedMeetingState}\n\n${secondBrainBriefSection}`

  const withInjectedMemory = priorMeetingContext
    ? (template.includes('{prior_meeting_context_section}')
      ? withInjectedSecondBrain.replace(/{prior_meeting_context_section}/g, priorMeetingContext)
      : `${withInjectedSecondBrain}\n\n${priorMeetingContext}`)
    : withInjectedSecondBrain

  return interpolateContext(withInjectedMemory, meetingContext)
}

export async function* streamChatResponse(
  messages: Message[],
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' },
  priorMeetingContext?: string
): AsyncGenerator<string> {
  const fullContext = buildTranscriptContext(transcript, 0, CHAT_CONTEXT_CHAR_BUDGET)
  const signalChunks = transcript.slice(-Math.max(settings.suggestionContextWindow + 2, 8))
  const systemContent = buildPrompt(settings.chatSystemPrompt, fullContext, signalChunks, meetingContext, {}, priorMeetingContext)
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
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' },
  priorMeetingContext?: string
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
    },
    priorMeetingContext
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

  if (isWeakDetailedAnswer(fullResponse, suggestionType, transcript, meetingContext)) {
    console.warn('[streamDetailedAnswer] Groq returned weak/incomplete detail, using local fallback instead')
    yield buildLocalDetailedFallback(suggestionTitle, suggestionType, suggestionDetail, suggestionSay, transcript, meetingContext)
    return
  }

  yield fullResponse.trim()
}
