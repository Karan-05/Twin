'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { RefreshCw, Copy, Check, Loader2, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { generateSuggestionBatch } from '@/lib/suggestions'
import type { SuggestionBatch, Suggestion } from '@/lib/store'

const SUGGESTION_INTERVAL_S = 30
const FIRST_BATCH_DELAY_S = 30
const PRE_FIRE_S = 0
const EVENT_TRIGGER_COOLDOWN_MS = 6000

const TYPE_STYLES: Record<
  string,
  { bg: string; border: string; badgeBg: string; badgeText: string; label: string }
> = {
  question: {
    bg: 'bg-[#f0fdf4]',
    border: 'border-l-[#22c55e]',
    badgeBg: 'bg-[#dcfce7]',
    badgeText: 'text-[#16a34a]',
    label: 'Question',
  },
  talking_point: {
    bg: 'bg-[#eff6ff]',
    border: 'border-l-[#3b82f6]',
    badgeBg: 'bg-[#dbeafe]',
    badgeText: 'text-[#1d4ed8]',
    label: 'Talking Point',
  },
  answer: {
    bg: 'bg-[#fff7ed]',
    border: 'border-l-[#f97316]',
    badgeBg: 'bg-[#ffedd5]',
    badgeText: 'text-[#ea580c]',
    label: 'Answer',
  },
  fact_check: {
    bg: 'bg-[#faf5ff]',
    border: 'border-l-[#a855f7]',
    badgeBg: 'bg-[#f3e8ff]',
    badgeText: 'text-[#9333ea]',
    label: 'Fact Check',
  },
  clarification: {
    bg: 'bg-[#fffbeb]',
    border: 'border-l-[#eab308]',
    badgeBg: 'bg-[#fef9c3]',
    badgeText: 'text-[#ca8a04]',
    label: 'Clarification',
  },
}

function SuggestionCard({
  suggestion,
  onClickDetail,
}: {
  suggestion: Suggestion
  onClickDetail: (s: Suggestion) => void
}) {
  const style = TYPE_STYLES[suggestion.type] ?? TYPE_STYLES.question
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(`${suggestion.title}\n\n${suggestion.detail}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClickDetail(suggestion)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open detailed answer for suggestion: ${suggestion.title}`}
      onClick={() => onClickDetail(suggestion)}
      onKeyDown={handleKeyDown}
      className={`group cursor-pointer rounded-xl border border-border border-l-4 ${style.border} ${style.bg} px-3 py-2.5 hover:shadow-sm transition-all animate-slide-in`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium mb-1.5 ${style.badgeBg} ${style.badgeText}`}>
            {style.label}
          </span>
          <p className="text-text-secondary text-sm font-medium leading-snug">{suggestion.title}</p>
          {suggestion.say ? (
            <p className="text-text-secondary text-xs leading-relaxed mt-1.5 italic">
              {suggestion.say.length > 90 ? suggestion.say.slice(0, 87) + '...' : suggestion.say}
            </p>
          ) : (
            <p className="text-text-muted text-xs leading-relaxed mt-1.5">
              {suggestion.detail.length > 110 ? suggestion.detail.slice(0, 107) + '...' : suggestion.detail}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="opacity-70 md:opacity-0 md:group-hover:opacity-100 p-1 text-text-faint hover:text-text-muted transition-all rounded flex-shrink-0 mt-0.5"
          title="Copy suggestion"
          aria-label={`Copy suggestion: ${suggestion.title}`}
        >
          {copied ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
        </button>
      </div>
      <p className="text-text-faint text-[11px] mt-2 group-hover:text-text-muted transition-colors">
        Click for expanded answer →
      </p>
    </div>
  )
}

function BatchBlock({
  batch,
  isNew,
  defaultCollapsed,
  onClickDetail,
}: {
  batch: SuggestionBatch
  isNew: boolean
  defaultCollapsed?: boolean
  onClickDetail: (s: Suggestion) => void
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-text-faint text-xs">{batch.timestamp}</span>
        <div className="flex items-center gap-1.5">
          {isNew && (
            <span className="text-xs px-1.5 py-0.5 bg-accent-bg text-accent-dark font-medium rounded-full">
              new
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="p-0.5 text-text-faint hover:text-text-muted transition-colors"
            aria-label={collapsed ? `Expand suggestion batch from ${batch.timestamp}` : `Collapse suggestion batch from ${batch.timestamp}`}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>
      </div>
      {!collapsed && batch.suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} onClickDetail={onClickDetail} />
      ))}
    </div>
  )
}

function SkeletonBatch() {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 bg-surface-tertiary rounded-xl animate-pulse border border-border" />
      ))}
    </div>
  )
}

export default function SuggestionsPanel() {
  const {
    isRecording,
    transcript,
    liveTranscriptPreview,
    suggestionBatches,
    isGeneratingSuggestions,
    settings,
    apiKey,
    meetingContext,
    meetingState,
    priorMeetingContext,
    addSuggestionBatch,
    setIsGeneratingSuggestions,
    nextSuggestionIn,
    setNextSuggestionIn,
    clearSuggestions,
  } = useMeetingStore()

  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preFireRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isGeneratingRef = useRef(isGeneratingSuggestions)
  // Always-fresh refs so timers never capture stale closure values
  const transcriptRef = useRef(transcript)
  const apiKeyRef = useRef(apiKey)
  const settingsRef = useRef(settings)
  const meetingContextRef = useRef(meetingContext)
  const liveTranscriptPreviewRef = useRef(liveTranscriptPreview)
  const meetingStateRef = useRef(meetingState)
  const suggestionBatchesRef = useRef(suggestionBatches)
  const priorMeetingContextRef = useRef(priorMeetingContext)
  const lastTriggeredAtRef = useRef(0)

  useEffect(() => { isGeneratingRef.current = isGeneratingSuggestions }, [isGeneratingSuggestions])
  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { apiKeyRef.current = apiKey }, [apiKey])
  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { meetingContextRef.current = meetingContext }, [meetingContext])
  useEffect(() => { liveTranscriptPreviewRef.current = liveTranscriptPreview }, [liveTranscriptPreview])
  useEffect(() => { meetingStateRef.current = meetingState }, [meetingState])
  useEffect(() => { suggestionBatchesRef.current = suggestionBatches }, [suggestionBatches])
  useEffect(() => { priorMeetingContextRef.current = priorMeetingContext }, [priorMeetingContext])

  const triggerSuggestions = useCallback(async (reason = 'timer') => {
    const hasContext = transcriptRef.current.length > 0 || liveTranscriptPreviewRef.current.trim().length > 0
    if (!apiKeyRef.current || !hasContext || isGeneratingRef.current) return
    setIsGeneratingSuggestions(true)
    setError(null)
    try {
      const batch = await generateSuggestionBatch(
        transcriptRef.current,
        apiKeyRef.current,
        settingsRef.current,
        meetingContextRef.current,
        suggestionBatchesRef.current.slice(0, 2),
        priorMeetingContextRef.current ?? undefined,
        {
          liveTranscriptPreview: liveTranscriptPreviewRef.current,
          meetingState: meetingStateRef.current,
          triggerReason: reason,
        }
      )
      addSuggestionBatch(batch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate suggestions')
    } finally {
      setIsGeneratingSuggestions(false)
    }
  }, [addSuggestionBatch, setIsGeneratingSuggestions])

  const clearAllTimers = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (preFireRef.current) clearTimeout(preFireRef.current)
  }, [])

  const flushTranscriptBeforeRefresh = useCallback(async () => {
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
  }, [isRecording])

  // scheduleNext(delaySecs): countdown visible to user, then refresh on the cadence boundary
  const scheduleNext = useCallback((delaySecs = SUGGESTION_INTERVAL_S) => {
    clearAllTimers()
    setNextSuggestionIn(delaySecs)

    let remaining = delaySecs
    intervalRef.current = setInterval(() => {
      remaining = Math.max(0, remaining - 1)
      setNextSuggestionIn(remaining)
    }, 1000)

    // Pre-fire: kick off API call PRE_FIRE_S before countdown hits 0
    const preFire = Math.max(0, (delaySecs - PRE_FIRE_S) * 1000)
    preFireRef.current = setTimeout(async () => {
      clearAllTimers()
      await triggerSuggestions()
      scheduleNext()
    }, preFire)
  }, [triggerSuggestions, setNextSuggestionIn, clearAllTimers])

  useEffect(() => {
    if (isRecording) {
      scheduleNext(FIRST_BATCH_DELAY_S)
    } else {
      clearAllTimers()
    }
    return clearAllTimers
  }, [isRecording, scheduleNext, clearAllTimers])

  useEffect(() => {
    const handleTrigger = (event: Event) => {
      const reason = ((event as CustomEvent<{ reason?: string }>).detail?.reason) || 'event'
      const now = Date.now()
      if (now - lastTriggeredAtRef.current < EVENT_TRIGGER_COOLDOWN_MS) return
      lastTriggeredAtRef.current = now
      clearAllTimers()
      void triggerSuggestions(reason).finally(() => {
        if (isRecording) scheduleNext()
      })
    }

    window.addEventListener('meeting-copilot:suggestion-trigger', handleTrigger)
    return () => window.removeEventListener('meeting-copilot:suggestion-trigger', handleTrigger)
  }, [clearAllTimers, isRecording, scheduleNext, triggerSuggestions])

  const handleClickDetail = useCallback((suggestion: Suggestion) => {
    window.dispatchEvent(
      new CustomEvent('suggestion-clicked', { detail: suggestion })
    )
  }, [])

  const handleManualRefresh = async () => {
    clearAllTimers()
    try {
      await flushTranscriptBeforeRefresh()
      await triggerSuggestions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcript refresh failed')
    } finally {
      if (isRecording) scheduleNext()
    }
  }

  const m = Math.floor(nextSuggestionIn / 60)
  const s = nextSuggestionIn % 60
  const countdownStr = `${m}:${String(s).padStart(2, '0')}`

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-primary">
      {/* Column header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Suggestions</h2>
          {suggestionBatches.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 bg-accent-bg text-accent-dark font-medium rounded-full">
              {suggestionBatches.length} {suggestionBatches.length === 1 ? 'batch' : 'batches'}
            </span>
          )}
          {priorMeetingContext && (
            <span
              className="text-xs px-1.5 py-0.5 bg-violet-50 border border-violet-200 text-violet-700 font-medium rounded-full"
              title={priorMeetingContext}
            >
              ◈ Memory
            </span>
          )}
          {suggestionBatches.length > 0 && (
            <button
              type="button"
              onClick={clearSuggestions}
              disabled={isGeneratingSuggestions}
              className="inline-flex items-center gap-1 text-[11px] text-text-faint hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Clear suggestion batches"
            >
              <Trash2 size={11} />
              Clear
            </button>
          )}
        </div>
        {isGeneratingSuggestions && (
          <Loader2 size={12} className="text-accent animate-spin" />
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button onClick={handleManualRefresh} className="text-red-700 font-medium hover:underline ml-2">
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {isGeneratingSuggestions && <SkeletonBatch />}
        {!isGeneratingSuggestions && isRecording && liveTranscriptPreview && suggestionBatches.length === 0 && (
          <p className="text-text-faint text-xs text-center mt-8">
            Live transcript is flowing — suggestions can fire early on questions, risks, numbers, or blockers.
          </p>
        )}
        {!isGeneratingSuggestions && suggestionBatches.length === 0 && (
          <p className="text-text-faint text-xs text-center mt-12">
            {isRecording
              ? `First suggestions in ${countdownStr}`
              : 'Start recording to get live suggestions'}
          </p>
        )}
        {suggestionBatches.map((batch, i) => (
          <BatchBlock
            key={batch.id}
            batch={batch}
            isNew={i === 0}
            defaultCollapsed={i > 0}
            onClickDetail={handleClickDetail}
          />
        ))}
      </div>

      {/* Bottom controls bar */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-surface-secondary flex-shrink-0">
        {isRecording && !isGeneratingSuggestions ? (
          <span className="text-text-faint text-xs">Next refresh in {countdownStr}</span>
        ) : (
          <span className="text-text-faint text-xs">
            {isGeneratingSuggestions ? 'Generating…' : 'Auto-suggest when recording'}
          </span>
        )}
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={isGeneratingSuggestions || !apiKey || (!isRecording && transcript.length === 0)}
          aria-label="Refresh transcript and suggestions"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-text-on-accent font-medium rounded-lg transition-colors"
        >
          <RefreshCw size={11} className={isGeneratingSuggestions ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
    </div>
  )
}
