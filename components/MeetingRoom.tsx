'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Settings, Download, Pencil, Check } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { exportSession } from '@/lib/export'
import TranscriptPanel from './TranscriptPanel'
import SuggestionsPanel from './SuggestionsPanel'
import ChatPanel from './ChatPanel'

function ElapsedTimer({ startTime }: { startTime: number | null }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startTime) { setElapsed(0); return }
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime])

  if (!startTime) return null
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  const parts = h > 0
    ? [String(h), String(m).padStart(2, '0'), String(s).padStart(2, '0')]
    : [String(m), String(s).padStart(2, '0')]
  return (
    <span className="text-text-muted text-xs tabular-nums">
      {parts.join(':')}
    </span>
  )
}

export default function MeetingRoom() {
  const router = useRouter()
  const {
    transcript,
    suggestionBatches,
    messages,
    sessionTitle,
    sessionStartTime,
    isRecording,
    setApiKey,
    setSettings,
    setSessionTitle,
  } = useMeetingStore()

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(sessionTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const key = localStorage.getItem('groq_api_key') || ''
    setApiKey(key)
    const raw = localStorage.getItem('meeting_copilot_settings')
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        setSettings(parsed)
      } catch { /* use defaults */ }
    }
  }, [setApiKey, setSettings])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus()
  }, [editingTitle])

  const commitTitle = () => {
    const t = titleDraft.trim() || 'Untitled Meeting'
    setSessionTitle(t)
    setTitleDraft(t)
    setEditingTitle(false)
  }

  const handleTitleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitTitle()
    if (e.key === 'Escape') {
      setTitleDraft(sessionTitle)
      setEditingTitle(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-surface-primary">
      {/* Top nav — 52px */}
      <header className="flex items-center justify-between px-5 border-b border-border-strong bg-surface-primary flex-shrink-0 h-[52px]">
        {/* Logo */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <div className="w-7 h-7 bg-accent rounded-md flex items-center justify-center">
            <span className="text-text-on-accent font-bold text-sm leading-none">M</span>
          </div>
          <span className="text-text-primary font-semibold text-sm tracking-tight">MeetingCopilot</span>
        </div>

        {/* Centre: editable title + timer */}
        <div className="flex items-center gap-2 absolute left-1/2 -translate-x-1/2">
          {editingTitle ? (
            <div className="flex items-center gap-1">
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKey}
                onBlur={commitTitle}
                className="text-sm font-medium text-text-primary bg-surface-tertiary border border-accent rounded-full px-3 py-1 outline-none w-48"
              />
              <button onClick={commitTitle} className="text-accent hover:text-accent-dark">
                <Check size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setTitleDraft(sessionTitle); setEditingTitle(true) }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-secondary hover:bg-accent-bg border border-border transition-colors"
            >
              <span className="text-sm font-medium text-text-secondary max-w-[12rem] truncate">{sessionTitle}</span>
              <Pencil size={11} className="text-text-faint" />
            </button>
          )}
          <ElapsedTimer startTime={sessionStartTime} />
        </div>

        {/* Right: LIVE badge + actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {isRecording && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 bg-red-50 border border-red-200 text-red-600 rounded-full text-xs font-medium">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
              LIVE
            </span>
          )}
          <button
            onClick={() => exportSession(transcript, suggestionBatches, messages, sessionTitle)}
            className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
            title="Export JSON"
          >
            <Download size={15} />
          </button>
          <button
            onClick={() => router.push('/settings')}
            className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
            title="Settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* 3-column layout */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/3 border-r border-border overflow-hidden flex flex-col">
          <TranscriptPanel />
        </div>
        <div className="w-1/3 border-r border-border overflow-hidden flex flex-col">
          <SuggestionsPanel />
        </div>
        <div className="w-1/3 overflow-hidden flex flex-col">
          <ChatPanel />
        </div>
      </div>

      {/* Status bar — 28px */}
      <div className="flex items-center justify-between px-5 h-7 bg-surface-secondary border-t border-border text-xs text-text-faint flex-shrink-0">
        <span>Groq · openai/gpt-oss-120b</span>
        <span>
          {transcript.length} segments · {suggestionBatches.length} batches · {messages.filter((m) => m.role === 'user').length} messages
        </span>
      </div>
    </div>
  )
}
