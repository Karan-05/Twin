'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Settings, Download, Pencil, Check, KeyRound } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { exportSession } from '@/lib/export'
import { saveSession, findRelatedSessions, buildPriorContextSection } from '@/lib/memory'
import { loadSettings } from '@/lib/settings'
import TranscriptPanel from './TranscriptPanel'
import SuggestionsPanel from './SuggestionsPanel'
import ChatPanel from './ChatPanel'
import IntelligenceStrip from './IntelligenceStrip'

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
    meetingContext,
    intelligenceSummary,
    settings,
    apiKey,
    setApiKey,
    setSettings,
    setSessionTitle,
    setPriorMeetingContext,
  } = useMeetingStore()

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(sessionTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const key = localStorage.getItem('groq_api_key') || ''
    setApiKey(key)
    setSettings(loadSettings())
  }, [setApiKey, setSettings])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus()
  }, [editingTitle])

  // Load prior sessions from memory whenever meeting type is selected
  useEffect(() => {
    if (!meetingContext.meetingType) {
      setPriorMeetingContext(null)
      return
    }
    const related = findRelatedSessions({
      meetingType: meetingContext.meetingType,
      userRole: meetingContext.userRole,
      goal: meetingContext.goal,
      queryText: transcript.slice(-4).map((chunk) => chunk.text).join(' '),
    })
    const ctx = buildPriorContextSection(related)
    setPriorMeetingContext(ctx || null)
  }, [meetingContext.meetingType, meetingContext.userRole, meetingContext.goal, transcript, setPriorMeetingContext])

  // Auto-save session to memory when recording stops (if substantive)
  const prevRecordingRef = useRef(isRecording)
  useEffect(() => {
    const wasRecording = prevRecordingRef.current
    prevRecordingRef.current = isRecording
    if (wasRecording && !isRecording && transcript.length >= 5 && intelligenceSummary) {
      saveSession({
        date: new Date().toISOString(),
        meetingType: meetingContext.meetingType,
        userRole: meetingContext.userRole,
        goal: meetingContext.goal,
        summary: intelligenceSummary,
        transcriptSample: transcript.slice(-4).map((c) => c.text).join(' ').slice(0, 500),
      })
    }
  }, [isRecording, transcript, intelligenceSummary, meetingContext])

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

  const requestTranscriptFlush = async () => {
    if (!isRecording) return

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('meeting-copilot:transcript-flushed', handleDone as EventListener)
        reject(new Error('Transcript refresh timed out'))
      }, 15_000)

      const handleDone = (event: Event) => {
        const detail = (event as CustomEvent<{ requestId: string; error?: string }>).detail
        if (detail?.requestId !== requestId) return

        window.clearTimeout(timeout)
        window.removeEventListener('meeting-copilot:transcript-flushed', handleDone as EventListener)

        if (detail.error) {
          reject(new Error(detail.error))
          return
        }

        resolve()
      }

      window.addEventListener('meeting-copilot:transcript-flushed', handleDone as EventListener)
      window.dispatchEvent(
        new CustomEvent('meeting-copilot:flush-transcript', {
          detail: { requestId },
        })
      )
    })
  }

  const requestStopRecording = async () => {
    if (!isRecording) return

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('meeting-copilot:recording-stopped', handleDone as EventListener)
        reject(new Error('Stop recording timed out'))
      }, 20_000)

      const handleDone = (event: Event) => {
        const detail = (event as CustomEvent<{ requestId: string; error?: string }>).detail
        if (detail?.requestId !== requestId) return

        window.clearTimeout(timeout)
        window.removeEventListener('meeting-copilot:recording-stopped', handleDone as EventListener)

        if (detail.error) {
          reject(new Error(detail.error))
          return
        }

        resolve()
      }

      window.addEventListener('meeting-copilot:recording-stopped', handleDone as EventListener)
      window.dispatchEvent(
        new CustomEvent('meeting-copilot:stop-recording', {
          detail: { requestId },
        })
      )
    })
  }

  const handleExport = async () => {
    await requestTranscriptFlush().catch(() => {})
    const latestState = useMeetingStore.getState()
    exportSession(
      latestState.transcript,
      latestState.suggestionBatches,
      latestState.messages,
      latestState.sessionTitle,
      latestState.meetingContext,
      latestState.intelligenceSummary,
      latestState.sessionStartTime,
      latestState.settings,
      latestState.liveTranscriptPreview
    )
  }

  const handleOpenSettings = async () => {
    await requestStopRecording().catch(() => {})
    router.push('/settings')
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
              <button type="button" onClick={commitTitle} aria-label="Save meeting title" className="text-accent hover:text-accent-dark">
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
          {!apiKey && (
            <button
              type="button"
              onClick={() => { void handleOpenSettings() }}
              className="flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-300 text-amber-700 rounded-full text-xs font-medium hover:bg-amber-100 transition-colors"
              title="Groq API key not set — click to configure"
            >
              <KeyRound size={11} />
              Set API key
            </button>
          )}
          <button
            type="button"
            onClick={() => { void handleExport() }}
            className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
            title="Export JSON"
            aria-label="Export meeting session as JSON"
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            onClick={() => { void handleOpenSettings() }}
            className="p-2 text-text-muted hover:text-text-primary hover:bg-surface-secondary rounded-lg transition-colors"
            title="Settings"
            aria-label="Open settings"
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* 3-column layout */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="w-1/3 border-r border-border overflow-hidden flex flex-col min-h-0 min-w-0">
          <TranscriptPanel />
        </div>
        <div className="w-1/3 border-r border-border overflow-hidden flex flex-col min-h-0 min-w-0">
          <SuggestionsPanel />
        </div>
        <div className="w-1/3 overflow-hidden flex flex-col min-h-0 min-w-0">
          <ChatPanel />
        </div>
      </div>

      {/* Intelligence Strip */}
      <IntelligenceStrip />

      {/* Status bar — 28px */}
      <div className="flex items-center justify-between px-5 h-7 bg-surface-secondary border-t border-border text-xs text-text-faint flex-shrink-0">
        <span>
          Groq · gpt-oss-120b
          {meetingContext.meetingType && ` · ${meetingContext.meetingType}`}
          {meetingContext.userRole && ` / ${meetingContext.userRole}`}
        </span>
        <span>
          {transcript.length} segments · {suggestionBatches.length} batches · {messages.filter((m) => m.role === 'user').length} messages
        </span>
      </div>
    </div>
  )
}
