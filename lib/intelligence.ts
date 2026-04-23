import Groq from 'groq-sdk'
import type { TranscriptChunk, IntelligenceSummary, MeetingContext } from './store'
import { isGroqBudgetSkip, withGroqTextBudget } from './groqBudget'

const EMPTY: IntelligenceSummary = { decisions: [], actionItems: [], keyData: [], openQuestions: [] }

// Meeting-type-specific extraction guidance — what "decision" or "action item" means varies by context.
const MEETING_GUIDANCE: Record<string, string> = {
  'Sales Call': `Focus on: commitments made by either side (budget approval, next steps, timeline), specific numbers/pricing mentioned, objections raised but not resolved, named stakeholders and their roles.`,
  'Job Interview': `Focus on: explicit evaluation criteria stated by the interviewer, commitments on timeline or next steps, specific competencies probed (don't invent results), open items like references or take-home work.`,
  'Investor Pitch': `Focus on: investor concerns raised, specific metrics or claims made by the founder, commitments on due diligence or follow-up, named comparable companies or market data points.`,
  'Customer Discovery': `Focus on: explicit pain points stated (not implied), workarounds mentioned, quantified time/cost impacts, commitments to follow up or share contacts. Flag "nice to have" statements in open questions.`,
  'Standup': `Focus on: blockers named by any participant, work completed vs. committed yesterday, work committed for today, explicit handoffs or dependencies.`,
  '1:1': `Focus on: feedback explicitly given, commitments made by manager or report, career or growth topics raised, open items deferred to a future date.`,
  'Brainstorm': `Focus on: ideas explicitly selected for further development, criteria agreed upon for evaluation, tasks assigned to explore specific ideas, open questions about feasibility or resources.`,
  'Board Meeting': `Focus on: board-level decisions (votes, approvals, directives), metrics presented vs. prior targets, strategic questions raised but not resolved, governance items.`,
  'Team Review': `Focus on: missed targets and named owners, root causes explicitly stated, improvement actions with named owners and deadlines, patterns across multiple team members.`,
}

const DEFAULT_GUIDANCE = `Focus on: firm decisions with owner or context, tasks with clear action + owner, specific numbers/names/dates, and unresolved questions that block progress.`
const INTELLIGENCE_TRANSCRIPT_LIMIT = 10
const INTELLIGENCE_MAX_TOKENS = 220

function buildExtractionPrompt(transcript: TranscriptChunk[], meetingType?: string): string {
  const text = transcript.slice(-INTELLIGENCE_TRANSCRIPT_LIMIT).map((c) => `[${c.timestamp}] ${c.text}`).join('\n')
  const guidance = (meetingType ? MEETING_GUIDANCE[meetingType] : null) ?? DEFAULT_GUIDANCE

  return `Extract structured intelligence from this ${meetingType ? meetingType : 'meeting'} transcript.

## Extraction guidance for ${meetingType ?? 'this meeting type'}
${guidance}

## Transcript
${text}

## Output rules — strict
- decisions: Firm choices/commitments explicitly confirmed. Include who decided if named. NOT proposals or maybes.
- actionItems: Concrete tasks. Format: "[Owner]: [task] by [deadline]" when names/dates are available. Owner = "TBD" if unclear.
- keyData: Specific numbers, prices, names, dates, URLs, percentages worth preserving. ≤12 words each.
- openQuestions: Unresolved questions or ambiguities that WILL matter downstream. NOT rhetorical questions.
- Max 5 items per array. Each item ≤15 words. Only include items clearly supported by the transcript.
- Empty arrays are correct when nothing of that type occurred.

Return ONLY valid JSON, no markdown, no explanation:
{"decisions":[],"actionItems":[],"keyData":[],"openQuestions":[]}`
}

const EXTRACTION_PERSONA = `You are a precision meeting analyst. Your only job is to extract factual, transcript-supported intelligence — no inference, no interpretation, no inventions. Every item you output must be directly evidenced by something explicitly said. When in doubt, omit.`

export async function extractIntelligenceSummary(
  transcript: TranscriptChunk[],
  apiKey: string,
  meetingContext?: MeetingContext
): Promise<IntelligenceSummary> {
  if (transcript.length < 2) return EMPTY

  const groq = new Groq({ apiKey, dangerouslyAllowBrowser: true })
  const meetingType = meetingContext?.meetingType || undefined
  const prompt = buildExtractionPrompt(transcript, meetingType)

  let response
  try {
    response = await withGroqTextBudget(`${EXTRACTION_PERSONA}\n\n${prompt}`, INTELLIGENCE_MAX_TOKENS, 'low', () => groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: EXTRACTION_PERSONA },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: INTELLIGENCE_MAX_TOKENS,
    }))
  } catch (error) {
    if (isGroqBudgetSkip(error)) return EMPTY
    throw error
  }

  try {
    const raw = response.choices[0]?.message?.content ?? '{}'
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    const jsonStr = start !== -1 && end !== -1 ? cleaned.slice(start, end + 1) : cleaned
    const parsed = JSON.parse(jsonStr) as IntelligenceSummary
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 5) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 5) : [],
      keyData: Array.isArray(parsed.keyData) ? parsed.keyData.slice(0, 5) : [],
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.slice(0, 5) : [],
    }
  } catch {
    return EMPTY
  }
}
