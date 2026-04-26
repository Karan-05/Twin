'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import { Send, Trash2, Sparkles, Copy, Check } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { streamChatResponse, streamDetailedAnswer } from '@/lib/chat'
import { generateId, formatTimestamp } from '@/lib/utils'
import { ErrorBoundary } from './ErrorBoundary'
import type { Suggestion, IntelligenceSummary } from '@/lib/store'

function TypingIndicator() {
  return (
    <span className="flex items-center gap-1 py-1 px-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 bg-text-faint rounded-full animate-typing-dot"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  )
}

// **bold**, *italic*, `code`, and [HH:MM:SS] timestamp citations
function renderInline(text: string, onTimestampClick?: (ts: string) => void): React.ReactNode {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[\d{1,2}:\d{2}(?::\d{2})?\])/g)
  if (parts.length === 1) return text
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i} className="font-bold text-[#4d7c0f]">{part.slice(2, -2)}</strong>
        if (part.startsWith('*') && part.endsWith('*'))
          return <em key={i} className="italic text-text-primary">{part.slice(1, -1)}</em>
        if (part.startsWith('`') && part.endsWith('`'))
          return <code key={i} className="bg-accent-bg text-[#4d7c0f] font-mono text-[11px] px-1.5 py-0.5 rounded border border-accent-border">{part.slice(1, -1)}</code>
        const tsMatch = part.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]$/)
        if (tsMatch) {
          return onTimestampClick ? (
            <button
              key={i}
              onClick={() => onTimestampClick(tsMatch[1])}
              className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] font-mono bg-amber-50 border border-amber-200 text-amber-700 rounded hover:bg-amber-100 transition-colors cursor-pointer mx-0.5"
              title={`Jump to ${tsMatch[1]}`}
            >
              ⏱ {tsMatch[1]}
            </button>
          ) : (
            <span key={i} className="inline text-[10px] font-mono text-text-faint mx-0.5">{part}</span>
          )
        }
        return part
      })}
    </>
  )
}

function TableBlock({ lines, onTimestampClick }: { lines: string[]; onTimestampClick?: (ts: string) => void }) {
  const rows = lines.map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  const dataRows = rows.filter((r) => !r.every((c) => /^[-: ]+$/.test(c)))
  const [header, ...body] = dataRows
  if (!header?.length) return null
  return (
    <div className="overflow-x-auto rounded-xl border border-border my-2">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-accent-bg">
            {header.map((cell, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-[#4d7c0f] border-b border-accent-border">
                {renderInline(cell, onTimestampClick)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'bg-surface-primary' : 'bg-surface-secondary'}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2 text-text-secondary border-b border-border last:border-b-0">
                  {renderInline(cell, onTimestampClick)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MarkdownMessage({ text, isUser, onTimestampClick }: { text: string; isUser: boolean; onTimestampClick?: (ts: string) => void }) {
  if (isUser) {
    return <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
  }

  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      if (nodes.length > 0) nodes.push(<div key={`sp-${i}`} className="h-1.5" />)
      i++
      continue
    }

    // Table block
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      nodes.push(<TableBlock key={`tbl-${i}`} lines={tableLines} onTimestampClick={onTimestampClick} />)
      continue
    }

    // Blockquote → key data callout (address / time / number to remember)
    if (trimmed.startsWith('> ')) {
      nodes.push(
        <div key={i} className="flex items-start gap-2.5 bg-accent-bg border-l-[3px] border-accent rounded-r-xl px-3 py-2 my-1">
          <span className="text-accent text-[8px] mt-1 flex-shrink-0">◆</span>
          <span className="text-sm font-semibold text-text-primary leading-snug">{renderInline(trimmed.slice(2), onTimestampClick)}</span>
        </div>
      )
      i++
      continue
    }

    // "In short:" / "TL;DR" → prominent summary box — the first thing eyes hit
    if (trimmed.match(/^\*\*(In short|TL;DR|Bottom line|Key takeaway)[:\s]/i)) {
      nodes.push(
        <div key={i} className="bg-accent-bg rounded-xl px-3.5 py-2.5 border border-accent-border my-1 shadow-sm">
          <p className="text-sm font-semibold text-text-primary leading-snug">
            {renderInline(trimmed, onTimestampClick)}
          </p>
        </div>
      )
      i++
      continue
    }

    // H2 header — left lime bar
    if (trimmed.startsWith('## ')) {
      nodes.push(
        <p key={i} className="text-sm font-bold text-text-primary mt-2.5 mb-0.5 border-l-2 border-accent pl-2">
          {renderInline(trimmed.slice(3), onTimestampClick)}
        </p>
      )
      i++
      continue
    }

    // H3 header
    if (trimmed.startsWith('### ')) {
      nodes.push(
        <p key={i} className="text-[11px] font-bold text-text-muted uppercase tracking-widest mt-2 mb-0.5">
          {renderInline(trimmed.slice(4), onTimestampClick)}
        </p>
      )
      i++
      continue
    }

    // Checkbox action items — lime box with empty checkbox
    if (trimmed.match(/^[-*]\s\[\s?\]/)) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t.match(/^[-*]\s\[\s?\]/)) break
        items.push(
          <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed">
            <span className="w-3.5 h-3.5 rounded border-2 border-accent flex-shrink-0 mt-[3px]" />
            <span className="text-text-secondary">{renderInline(t.replace(/^[-*]\s\[\s?\]\s?/, ''), onTimestampClick)}</span>
          </li>
        )
        i++
      }
      nodes.push(
        <ul key={`cb-${i}`} className="space-y-2 my-1.5 bg-accent-bg rounded-xl p-3 border border-accent-border">
          {items}
        </ul>
      )
      continue
    }

    // Bullet list
    if (trimmed.match(/^[-•*]\s/)) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t.match(/^[-•*]\s/) || t.match(/^[-*]\s\[\s?\]/)) break
        items.push(
          <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
            <span className="text-accent flex-shrink-0 mt-[6px] text-[6px]">◆</span>
            <span className="text-text-secondary">{renderInline(t.slice(2), onTimestampClick)}</span>
          </li>
        )
        i++
      }
      nodes.push(<ul key={`ul-${i}`} className="space-y-1 my-0.5">{items}</ul>)
      continue
    }

    // Numbered list
    if (trimmed.match(/^\d+\.\s/)) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        const m = t.match(/^(\d+)\.\s(.+)/)
        if (!m) break
        items.push(
          <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
            <span className="text-accent font-bold flex-shrink-0 min-w-[18px] text-right">{m[1]}.</span>
            <span className="text-text-secondary">{renderInline(m[2], onTimestampClick)}</span>
          </li>
        )
        i++
      }
      nodes.push(<ol key={`ol-${i}`} className="space-y-1 my-0.5">{items}</ol>)
      continue
    }

    // Regular paragraph
    nodes.push(
      <p key={i} className="text-sm leading-relaxed text-text-secondary">
        {renderInline(trimmed, onTimestampClick)}
      </p>
    )
    i++
  }

  return <div className="space-y-0.5">{nodes}</div>
}

function hasSummaryData(summary: IntelligenceSummary | null): boolean {
  return Boolean(summary && (
    summary.overview ||
    summary.decisions.length > 0 ||
    summary.actionItems.length > 0 ||
    summary.keyData.length > 0 ||
    summary.openQuestions.length > 0
  ))
}

function SummaryCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-primary transition-colors"
      aria-label="Copy conversation recap"
    >
      {copied ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
      {copied ? 'Copied' : 'Copy recap'}
    </button>
  )
}

function buildSummaryCopyText(summary: IntelligenceSummary): string {
  const sections = [
    summary.overview ? `Overview\n${summary.overview}` : '',
    summary.decisions.length > 0 ? `Decisions\n${summary.decisions.map((item) => `- ${item}`).join('\n')}` : '',
    summary.actionItems.length > 0 ? `Action Items\n${summary.actionItems.map((item) => `- ${item}`).join('\n')}` : '',
    summary.keyData.length > 0 ? `Important Facts\n${summary.keyData.map((item) => `- ${item}`).join('\n')}` : '',
    summary.openQuestions.length > 0 ? `Open Questions\n${summary.openQuestions.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean)

  return sections.join('\n\n')
}

function RecapCard({ summary }: { summary: IntelligenceSummary }) {
  const summaryText = buildSummaryCopyText(summary)

  return (
    <div className="rounded-2xl border border-accent-border bg-accent-bg/60 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-accent-bg border border-accent-border flex items-center justify-center text-accent-dark">
            <Sparkles size={13} />
          </div>
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Conversation Recap</p>
            <p className="text-[11px] text-text-faint">Generated when recording stopped</p>
          </div>
        </div>
        <SummaryCopyButton text={summaryText} />
      </div>

      {summary.overview && (
        <div className="rounded-xl border border-accent-border bg-surface-primary px-3 py-2">
          <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1">What This Was About</p>
          <p className="text-sm text-text-secondary leading-relaxed">{summary.overview}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {summary.keyData.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">Important Facts</p>
            <ul className="space-y-1">
              {summary.keyData.map((item, i) => <li key={i} className="text-xs text-text-secondary leading-snug">- {item}</li>)}
            </ul>
          </div>
        )}
        {summary.decisions.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">Decisions</p>
            <ul className="space-y-1">
              {summary.decisions.map((item, i) => <li key={i} className="text-xs text-text-secondary leading-snug">- {item}</li>)}
            </ul>
          </div>
        )}
        {summary.actionItems.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">Action Items</p>
            <ul className="space-y-1">
              {summary.actionItems.map((item, i) => <li key={i} className="text-xs text-text-secondary leading-snug">- {item}</li>)}
            </ul>
          </div>
        )}
        {summary.openQuestions.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">Open Questions</p>
            <ul className="space-y-1">
              {summary.openQuestions.map((item, i) => <li key={i} className="text-xs text-text-secondary leading-snug">- {item}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ChatPanel() {
  const {
    messages,
    transcript,
    settings,
    meetingContext,
    priorMeetingContext,
    addMessage,
    updateLastMessage,
    apiKey,
    isStreamingChat,
    setIsStreamingChat,
    setFocusedChunkId,
    clearMessages,
    intelligenceSummary,
    isExtractingIntelligence,
    isRecording,
  } = useMeetingStore()

  const transcriptRef = useRef(transcript)
  useEffect(() => { transcriptRef.current = transcript }, [transcript])

  const handleTimestampClick = useCallback((ts: string) => {
    const chunk = transcriptRef.current.find((c) => c.timestamp === ts)
      ?? transcriptRef.current.find((c) => c.timestamp.startsWith(ts.slice(0, 5)))
    if (chunk) setFocusedChunkId(chunk.id)
  }, [setFocusedChunkId])

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(
    async (text: string, isDetailedAnswer = false, suggestion?: Suggestion) => {
      if (!text.trim() || isStreamingChat) return
      if (!apiKey) {
        setError('Add your Groq API key in Settings before using chat.')
        return
      }

      setError(null)

      const userMsg = {
        id: generateId(),
        role: 'user' as const,
        content: text,
        timestamp: formatTimestamp(new Date()),
      }
      addMessage(userMsg)

      const assistantMsg = {
        id: generateId(),
        role: 'assistant' as const,
        content: '',
        timestamp: formatTimestamp(new Date()),
      }
      addMessage(assistantMsg)
      setIsStreamingChat(true)

      try {
        let accumulated = ''

        if (isDetailedAnswer && suggestion) {
          for await (const delta of streamDetailedAnswer(
            suggestion.title,
            suggestion.type,
            suggestion.detail,
            suggestion.say,
            suggestion.whyNow,
            suggestion.listenFor,
            transcript,
            apiKey,
            settings,
            meetingContext,
            priorMeetingContext ?? undefined
          )) {
            accumulated += delta
            updateLastMessage(accumulated)
          }
        } else {
          // snapshot messages before adding assistant placeholder
          const allMessages = [...messages, userMsg]
          for await (const delta of streamChatResponse(
            allMessages,
            transcript,
            apiKey,
            settings,
            meetingContext,
            priorMeetingContext ?? undefined
          )) {
            accumulated += delta
            updateLastMessage(accumulated)
          }
        }

        if (!accumulated) updateLastMessage('(no response)')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Chat request failed'
        setError(msg)
        updateLastMessage('(response interrupted)')
      } finally {
        setIsStreamingChat(false)
      }
    },
    [isStreamingChat, messages, transcript, apiKey, settings, meetingContext, priorMeetingContext, addMessage, updateLastMessage, setIsStreamingChat]
  )

  useEffect(() => {
    const handler = (e: Event) => {
      const suggestion = (e as CustomEvent<Suggestion>).detail
      const clickedPrompt = suggestion.say
        ? `Expand: ${suggestion.title}\n${suggestion.say}`
        : `Expand: ${suggestion.title}\n${suggestion.detail}`
      sendMessage(clickedPrompt, true, suggestion)
    }
    window.addEventListener('suggestion-clicked', handler)
    return () => window.removeEventListener('suggestion-clicked', handler)
  }, [sendMessage])

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-primary">
      {/* Column header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Meeting Assistant</h2>
        <div className="flex items-center gap-3">
          <span className="text-text-faint text-xs">Ask anything · Click suggestions</span>
          <button
            type="button"
            onClick={clearMessages}
            disabled={messages.length === 0 || isStreamingChat}
            className="inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Clear assistant messages"
          >
            <Trash2 size={11} />
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {!isRecording && isExtractingIntelligence && !hasSummaryData(intelligenceSummary) && (
          <div className="rounded-2xl border border-border bg-surface-secondary px-4 py-3">
            <p className="text-sm font-medium text-text-primary">Building final conversation recap…</p>
            <p className="text-xs text-text-faint mt-1">Capturing what the conversation was about, important facts, decisions, action items, and open questions.</p>
          </div>
        )}

        {!isRecording && hasSummaryData(intelligenceSummary) && intelligenceSummary && (
          <RecapCard summary={intelligenceSummary} />
        )}

        {messages.length === 0 ? (
          <p className="text-text-faint text-xs text-center mt-12">
            {hasSummaryData(intelligenceSummary) && !isRecording
              ? 'Ask follow-up questions about the recap or click a suggestion to get details'
              : 'Ask questions about the meeting or click a suggestion to get details'}
          </p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-accent-bg border border-accent-border flex items-center justify-center text-xs font-bold text-accent-dark mr-2 mt-1 flex-shrink-0">
                  AI
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${
                  msg.role === 'user'
                    ? 'bg-accent text-text-on-accent rounded-br-sm shadow-sm'
                    : 'bg-surface-primary text-text-secondary border border-border rounded-bl-sm'
                }`}
              >
                {msg.content ? (
                  <ErrorBoundary fallback={<pre className="text-xs whitespace-pre-wrap text-text-secondary">{msg.content}</pre>}>
                    <MarkdownMessage
                      text={msg.content}
                      isUser={msg.role === 'user'}
                      onTimestampClick={msg.role === 'assistant' ? handleTimestampClick : undefined}
                    />
                  </ErrorBoundary>
                ) : (
                  <TypingIndicator />
                )}
                <p
                  className={`text-xs mt-1 ${
                    msg.role === 'user' ? 'text-text-on-accent opacity-60' : 'text-text-faint'
                  }`}
                >
                  {msg.timestamp}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="mx-4 mb-2 px-3 py-2 bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button className="text-red-700 font-medium hover:underline ml-2" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-border flex-shrink-0">
        <div className="flex items-end gap-2 bg-surface-primary rounded-xl border border-border-strong focus-within:border-accent transition-colors px-3 py-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={apiKey ? 'Ask about the meeting… Enter sends · Shift+Enter adds a new line' : 'Add your Groq API key in Settings to use chat'}
            rows={1}
            className="flex-1 bg-transparent text-text-primary text-sm placeholder-text-faint resize-none focus:outline-none max-h-32 overflow-y-auto"
            style={{ lineHeight: '1.5' }}
          />
          <button
            onClick={handleSend}
            disabled={!apiKey || !input.trim() || isStreamingChat}
            type="button"
            aria-label="Send chat message"
            className="p-1.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-text-on-accent rounded-lg transition-colors flex-shrink-0"
          >
            <Send size={14} />
          </button>
        </div>
        <p className="text-text-faint text-xs mt-1.5 px-1">Enter sends · Shift+Enter adds a new line</p>
      </div>
    </div>
  )
}
