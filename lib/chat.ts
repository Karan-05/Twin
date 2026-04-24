import Groq from 'groq-sdk'
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions'
import type { Message, TranscriptChunk, MeetingContext } from './store'
import type { AppSettings } from './settings'
import { buildConversationSignalsSection, extractConversationSignals, extractPrimaryTopic, selectActionableQuestion } from './contextSignals'
import { buildDecisionScaffoldingSection } from './decisionScaffolding'
import { buildMeetingStateSection, deriveMeetingState } from './meetingState'
import { withGroqTextBudget } from './groqBudget'

const RESPONSE_GUARDRAILS = `You are a live meeting copilot. Never invent customer names, metrics, timelines, proof points, roles, or examples that are not explicitly present in the transcript or user message. If a stronger answer needs missing facts, use a fill-in-the-blank scaffold like [insert your real example] instead of fabricating.`
const CHAT_CONTEXT_CHAR_BUDGET = 4200
const DETAIL_CONTEXT_CHAR_BUDGET = 3600
const CHAT_MAX_TOKENS = 700
const DETAIL_MAX_TOKENS = 580

type QuestionCategory = 'definition' | 'mechanism' | 'comparison' | 'reason' | 'tradeoff' | 'implementation' | 'general'

function inferQuestionCategory(text: string): QuestionCategory {
  const lower = text.toLowerCase()
  if (/\bwhat is\b|\bwhat's\b|\bdefine\b|\bmeaning of\b/.test(lower)) return 'definition'
  if (/\bhow does\b|\bhow do\b|\bhow can\b|\bhow to\b|\bworks?\b/.test(lower)) return 'mechanism'
  if (/\bcompare\b|\bversus\b|\bvs\b|\bdifference\b|\bbetter than\b/.test(lower)) return 'comparison'
  if (/\bwhy\b|\bimportance\b|\bmatter\b/.test(lower)) return 'reason'
  if (/\btradeoff\b|\btrade-off\b|\bpros and cons\b|\bdownside\b|\bupside\b/.test(lower)) return 'tradeoff'
  if (/\bimplement\b|\bintegration\b|\brollout\b|\bonboarding\b|\bfirst two weeks\b/.test(lower)) return 'implementation'
  return 'general'
}

function isSellerishSalesContext(meetingContext: MeetingContext): boolean {
  return meetingContext.meetingType === 'Sales Call' && /\b(seller|account executive|sales manager)\b/i.test(meetingContext.userRole || '')
}

function inferSalesWorkflowSummary(transcript: TranscriptChunk[]): string {
  const text = transcript.map((chunk) => chunk.text).join(' ').toLowerCase()
  if (/\bdeal sourc|outbound|calling\b/.test(text)) return 'outbound calling and deal sourcing'
  if (/\bfollow[- ]?up\b/.test(text)) return 'follow-up conversations'
  if (/\bqualif(y|ication)\b/.test(text)) return 'lead qualification'
  if (/\bappointment|book meetings?\b/.test(text)) return 'meeting booking'
  return 'customer conversations'
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
  const llmLike = /\b(llm|large language model|tokenization|tokenisation|embedding|embeddings|attention|transformer)\b/i.test(`${topic} ${userMessage} ${question?.text ?? ''}`)

  if (llmLike) {
    return [
      '**In short:** Explain the runtime path clearly: **tokenization -> embeddings -> transformer attention -> next-token decoding**.',
      question ? `- Open question: "${question.text}" [${question.timestamp}]` : `- Topic: **${topic}**`,
      '- Tokenization splits the input text into model-sized tokens.',
      '- Embeddings turn those tokens into vectors, and positional information preserves order.',
      '- Transformer self-attention layers update each token representation using the surrounding context.',
      '- Decoding picks the next token repeatedly until the model reaches a stopping point.',
      '> "Say: An LLM tokenizes the prompt, maps tokens to embeddings, runs attention over the sequence, and predicts the next token repeatedly until the answer is complete."',
      '- Groq is temporarily rate-limited, so this is a local technical fallback.',
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
  const topic = extractPrimaryTopic(transcript.slice(-8), `${meetingContext.goal} ${suggestionTitle}`) || 'current topic'
  const category = inferQuestionCategory(openQuestion?.text ?? suggestionTitle)
  const llmLike = /\b(llm|large language model|tokenization|tokenisation|embedding|embeddings|attention|transformer)\b/i.test(`${topic} ${suggestionTitle} ${openQuestion?.text ?? ''}`)
  const salesVoiceAgents =
    isSellerishSalesContext(meetingContext) &&
    /\bvoice ai agents?\b|\bvoice agents?\b|\bagents?\b/.test(`${topic} ${suggestionTitle} ${openQuestion?.text ?? ''}`)
  const workflowSummary = inferSalesWorkflowSummary(transcript)

  const anchor =
    suggestionType === 'answer' || suggestionType === 'question' ? openQuestion ?? latest
    : suggestionType === 'fact_check' ? riskyItem ?? latest
    : suggestionType === 'clarification' ? commitment ?? riskyItem ?? latest
    : latest

  const evidenceLine = anchor
    ? `**Evidence:** "${anchor.text}" [${anchor.timestamp}]`
    : '**Evidence:** Thin transcript — using suggestion framing.'

  if ((suggestionType === 'answer' || suggestionType === 'talking_point') && llmLike) {
    return [
      evidenceLine,
      '',
      '**In short:** Explain the runtime path: **tokenization -> embeddings -> transformer attention -> next-token decoding**.',
      '- Tokenization breaks the input text into tokens the model can process.',
      '- Embeddings convert those tokens into vectors, and positional information preserves order in the sequence.',
      '- Transformer attention layers update each token representation using the surrounding context, which is where the model gets contextual understanding.',
      '- Decoding then chooses one token at a time until the answer is complete; training is the earlier process that taught those weights what token patterns are likely.',
      '> "Say: An LLM tokenizes the prompt, maps tokens into embeddings, runs attention over the sequence to build context, and then predicts the next token repeatedly until the full answer is formed."',
      '- [ ] Next step to lock: ask whether they want the training loop next, or a deeper dive on embeddings versus attention.',
    ].join('\n')
  }

  if ((suggestionType === 'answer' || suggestionType === 'talking_point') && salesVoiceAgents) {
    return [
      evidenceLine,
      '',
      '**In short:** Define the agent category clearly, tie it to one workflow, then ask which workflow they want first.',
      `- They are not asking for architecture yet. They are asking what kind of **${topic}** you actually mean in business terms.`,
      `- Anchor on the workflow already in the transcript: **${workflowSummary}**, with **24/7** availability and lower cost than a purely human calling workflow [${latest?.timestamp ?? 'LIVE'}].`,
      `- Keep the answer concrete: category first, use case second, business value third. Do not drift into generic AI language.`,
      `> "Say: We are mainly talking about ${workflowSummary} agents that stay available 24/7, handle repetitive customer conversations, and cost less than a purely human team for that workflow. The real question is which workflow you would want to automate first."`,
      `- [ ] Next step to lock: ask which workflow matters most for them first, then tailor the rest of the pitch to that one path.`,
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
        `> "Say: [Ask it directly — what you actually want to know, nothing more]."`,
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
        `> "Say: Before we move on — can we agree on [the specific undefined thing] so there's no confusion later?"`,
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
        `> "Say: The key thing to add here is [your insight] — which means we should [concrete next step]."`,
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
  transcript: TranscriptChunk[],
  apiKey: string,
  settings: AppSettings,
  meetingContext: MeetingContext = { meetingType: '', userRole: '', goal: '', prepNotes: '' }
): AsyncGenerator<string> {
  const detailChunks = settings.detailContextWindow > 0 ? transcript.slice(-settings.detailContextWindow) : transcript
  const fullContext = buildTranscriptContext(transcript, settings.detailContextWindow, DETAIL_CONTEXT_CHAR_BUDGET)

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })

  const prompt = buildPrompt(
    settings.clickDetailPrompt
      .replace('{suggestion_title}', suggestionTitle)
      .replace('{suggestion_detail}', suggestionDetail),
    fullContext,
    detailChunks,
    meetingContext,
    { suggestion_type: suggestionType }
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

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) yield delta
  }
}
