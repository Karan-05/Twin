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
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
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
