'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { RefreshCw, Copy, Check, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { generateSuggestionBatch } from '@/lib/suggestions'
import type { SuggestionBatch, Suggestion } from '@/lib/store'

const SUGGESTION_INTERVAL_S = 30

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

  return (
    <div
      onClick={() => onClickDetail(suggestion)}
      className={`group cursor-pointer rounded-xl border border-border border-l-4 ${style.border} ${style.bg} px-3 py-2.5 hover:shadow-sm transition-all animate-slide-in`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium mb-1.5 ${style.badgeBg} ${style.badgeText}`}>
            {style.label}
          </span>
          <p className="text-text-secondary text-sm font-medium leading-snug">{suggestion.title}</p>
        </div>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 p-1 text-text-faint hover:text-text-muted transition-all rounded flex-shrink-0 mt-0.5"
          title="Copy"
        >
          {copied ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
        </button>
      </div>
      <p className="text-text-faint text-xs mt-1.5 group-hover:text-text-muted transition-colors">
        Click for details →
      </p>
    </div>
  )
}

function BatchBlock({
  batch,
  isNew,
  onClickDetail,
}: {
  batch: SuggestionBatch
  isNew: boolean
  onClickDetail: (s: Suggestion) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

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
            onClick={() => setCollapsed((v) => !v)}
            className="p-0.5 text-text-faint hover:text-text-muted transition-colors"
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
    suggestionBatches,
    isGeneratingSuggestions,
    settings,
    apiKey,
    addSuggestionBatch,
    setIsGeneratingSuggestions,
    nextSuggestionIn,
    setNextSuggestionIn,
  } = useMeetingStore()

  const [error, setError] = useState<string | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoTriggerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isGeneratingRef = useRef(isGeneratingSuggestions)

  useEffect(() => {
    isGeneratingRef.current = isGeneratingSuggestions
  }, [isGeneratingSuggestions])

  const triggerSuggestions = useCallback(async () => {
    if (!apiKey || transcript.length === 0 || isGeneratingRef.current) return
    setIsGeneratingSuggestions(true)
    setError(null)
    try {
      const batch = await generateSuggestionBatch(transcript, apiKey, settings)
      addSuggestionBatch(batch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate suggestions')
    } finally {
      setIsGeneratingSuggestions(false)
    }
  }, [apiKey, transcript, settings, addSuggestionBatch, setIsGeneratingSuggestions])

  const resetCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (autoTriggerRef.current) clearTimeout(autoTriggerRef.current)
    setNextSuggestionIn(SUGGESTION_INTERVAL_S)

    let remaining = SUGGESTION_INTERVAL_S
    countdownRef.current = setInterval(() => {
      remaining = Math.max(0, remaining - 1)
      setNextSuggestionIn(remaining)
    }, 1000)

    autoTriggerRef.current = setTimeout(async () => {
      await triggerSuggestions()
      resetCountdown()
    }, SUGGESTION_INTERVAL_S * 1000)
  }, [triggerSuggestions, setNextSuggestionIn])

  useEffect(() => {
    if (isRecording) {
      resetCountdown()
    } else {
      if (countdownRef.current) clearInterval(countdownRef.current)
      if (autoTriggerRef.current) clearTimeout(autoTriggerRef.current)
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
      if (autoTriggerRef.current) clearTimeout(autoTriggerRef.current)
    }
  }, [isRecording]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClickDetail = useCallback((suggestion: Suggestion) => {
    window.dispatchEvent(
      new CustomEvent('suggestion-clicked', { detail: suggestion })
    )
  }, [])

  const handleManualRefresh = () => {
    triggerSuggestions().then(() => {
      if (isRecording) resetCountdown()
    })
  }

  const m = Math.floor(nextSuggestionIn / 60)
  const s = nextSuggestionIn % 60
  const countdownStr = `${m}:${String(s).padStart(2, '0')}`

  return (
    <div className="flex flex-col h-full bg-surface-primary">
      {/* Column header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Suggestions</h2>
          {suggestionBatches.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 bg-accent-bg text-accent-dark font-medium rounded-full">
              {suggestionBatches.length} {suggestionBatches.length === 1 ? 'batch' : 'batches'}
            </span>
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

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {isGeneratingSuggestions && <SkeletonBatch />}
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
          onClick={handleManualRefresh}
          disabled={isGeneratingSuggestions || !apiKey || transcript.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-text-on-accent font-medium rounded-lg transition-colors"
        >
          <RefreshCw size={11} className={isGeneratingSuggestions ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
    </div>
  )
}
