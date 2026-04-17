'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import { Send } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { streamChatResponse, streamDetailedAnswer } from '@/lib/chat'
import { generateId, formatTimestamp } from '@/lib/utils'
import type { Suggestion } from '@/lib/store'

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

// Renders inline markdown: **bold**, *italic*, `code`
function renderInline(text: string, key?: string | number): React.ReactNode {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g)
  if (parts.length === 1) return text
  return (
    <span key={key}>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i} className="font-semibold text-text-primary">{part.slice(2, -2)}</strong>
        if (part.startsWith('*') && part.endsWith('*'))
          return <em key={i} className="italic">{part.slice(1, -1)}</em>
        if (part.startsWith('`') && part.endsWith('`'))
          return <code key={i} className="bg-surface-tertiary text-accent-dark font-mono text-xs px-1 py-0.5 rounded">{part.slice(1, -1)}</code>
        return part
      })}
    </span>
  )
}

// Renders a full markdown message: headers, bullets, numbered lists, paragraphs
function MarkdownMessage({ text, isUser }: { text: string; isUser: boolean }) {
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
      if (nodes.length > 0) nodes.push(<div key={`gap-${i}`} className="h-1" />)
      i++
      continue
    }

    // H2/H3 headers
    if (trimmed.startsWith('### ')) {
      nodes.push(
        <p key={i} className="text-xs font-bold text-text-muted uppercase tracking-wider mt-2 mb-0.5">
          {renderInline(trimmed.slice(4))}
        </p>
      )
      i++
      continue
    }
    if (trimmed.startsWith('## ')) {
      nodes.push(
        <p key={i} className="text-sm font-bold text-text-primary mt-2 mb-0.5">
          {renderInline(trimmed.slice(3))}
        </p>
      )
      i++
      continue
    }

    // Numbered list: "1. item"
    const numberedMatch = trimmed.match(/^(\d+)\.\s(.+)/)
    if (numberedMatch) {
      const listItems: React.ReactNode[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        const m = t.match(/^(\d+)\.\s(.+)/)
        if (!m) break
        listItems.push(
          <li key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className="text-accent font-semibold flex-shrink-0 w-4">{m[1]}.</span>
            <span>{renderInline(m[2])}</span>
          </li>
        )
        i++
      }
      nodes.push(<ol key={`ol-${i}`} className="space-y-1 my-0.5">{listItems}</ol>)
      continue
    }

    // Bullet list: "- item" or "• item" or "* item"
    if (trimmed.match(/^[-•*]\s/)) {
      const listItems: React.ReactNode[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t.match(/^[-•*]\s/)) break
        listItems.push(
          <li key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className="text-accent mt-1.5 flex-shrink-0 text-xs">●</span>
            <span>{renderInline(t.slice(2))}</span>
          </li>
        )
        i++
      }
      nodes.push(<ul key={`ul-${i}`} className="space-y-1 my-0.5">{listItems}</ul>)
      continue
    }

    // Regular paragraph
    nodes.push(
      <p key={i} className="text-sm leading-relaxed">
        {renderInline(trimmed)}
      </p>
    )
    i++
  }

  return <div className="space-y-1">{nodes}</div>
}

export default function ChatPanel() {
  const {
    messages,
    transcript,
    settings,
    addMessage,
    updateLastMessage,
    apiKey,
    isStreamingChat,
    setIsStreamingChat,
  } = useMeetingStore()

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
            suggestion.detail,
            transcript,
            apiKey,
            settings
          )) {
            accumulated += delta
            updateLastMessage(accumulated)
          }
        } else {
          // snapshot messages before adding assistant placeholder
          const allMessages = [...messages, userMsg]
          for await (const delta of streamChatResponse(allMessages, transcript, apiKey, settings)) {
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
    [isStreamingChat, messages, transcript, apiKey, settings, addMessage, updateLastMessage, setIsStreamingChat]
  )

  useEffect(() => {
    const handler = (e: Event) => {
      const suggestion = (e as CustomEvent<Suggestion>).detail
      sendMessage(suggestion.title, true, suggestion)
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
    <div className="flex flex-col h-full bg-surface-primary">
      {/* Column header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Meeting Assistant</h2>
        <span className="text-text-faint text-xs">Ask anything · Click suggestions</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 ? (
          <p className="text-text-faint text-xs text-center mt-12">
            Ask questions about the meeting or click a suggestion to get details
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
                  <MarkdownMessage text={msg.content} isUser={msg.role === 'user'} />
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
            placeholder="Ask about the meeting… (Enter to send)"
            rows={1}
            className="flex-1 bg-transparent text-text-primary text-sm placeholder-text-faint resize-none focus:outline-none max-h-32 overflow-y-auto"
            style={{ lineHeight: '1.5' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreamingChat}
            className="p-1.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-text-on-accent rounded-lg transition-colors flex-shrink-0"
          >
            <Send size={14} />
          </button>
        </div>
        <p className="text-text-faint text-xs mt-1.5 px-1">Shift+Enter for new line</p>
      </div>
    </div>
  )
}
