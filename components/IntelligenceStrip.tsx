'use client'
import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { extractIntelligenceSummary } from '@/lib/intelligence'

const EXTRACT_INTERVAL_MS = 60_000
const FIRST_EXTRACT_DELAY_MS = 65_000 // wait for ~2 transcript refreshes before first extraction

const SECTION_CONFIG = [
  { key: 'decisions' as const, label: 'Decisions', dot: 'bg-[#22c55e]' },
  { key: 'actionItems' as const, label: 'Action Items', dot: 'bg-[#3b82f6]' },
  { key: 'keyData' as const, label: 'Key Data', dot: 'bg-[#f97316]' },
  { key: 'openQuestions' as const, label: 'Open Questions', dot: 'bg-[#a855f7]' },
]

export default function IntelligenceStrip() {
  const {
    isRecording,
    transcript,
    apiKey,
    meetingContext,
    intelligenceSummary,
    isExtractingIntelligence,
    isGeneratingSuggestions,
    isStreamingChat,
    setIntelligenceSummary,
    setIsExtractingIntelligence,
  } = useMeetingStore()

  const [collapsed, setCollapsed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transcriptRef = useRef(transcript)
  const apiKeyRef = useRef(apiKey)
  const meetingContextRef = useRef(meetingContext)

  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { apiKeyRef.current = apiKey }, [apiKey])
  useEffect(() => { meetingContextRef.current = meetingContext }, [meetingContext])

  const runExtraction = async () => {
    if (!apiKeyRef.current || transcriptRef.current.length < 2 || isGeneratingSuggestions || isStreamingChat) return
    setIsExtractingIntelligence(true)
    try {
      const summary = await extractIntelligenceSummary(
        transcriptRef.current,
        apiKeyRef.current,
        meetingContextRef.current
      )
      setIntelligenceSummary(summary)
    } catch {
      // silent fail — don't disrupt recording
    } finally {
      setIsExtractingIntelligence(false)
    }
  }

  useEffect(() => {
    if (!isRecording) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    // Run after enough transcript has accumulated, then keep a slower background cadence.
    const initial = setTimeout(() => {
      runExtraction()
      timerRef.current = setInterval(runExtraction, EXTRACT_INTERVAL_MS)
    }, FIRST_EXTRACT_DELAY_MS)
    return () => {
      clearTimeout(initial)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, isGeneratingSuggestions, isStreamingChat])

  const hasAnyData = intelligenceSummary && (
    intelligenceSummary.decisions.length > 0 ||
    intelligenceSummary.actionItems.length > 0 ||
    intelligenceSummary.keyData.length > 0 ||
    intelligenceSummary.openQuestions.length > 0
  )

  if (!isRecording && !hasAnyData) return null

  return (
    <div className="border-t border-border bg-surface-secondary flex-shrink-0">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-2 hover:bg-surface-tertiary transition-colors"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand meeting intelligence' : 'Collapse meeting intelligence'}
      >
        <div className="flex items-center gap-2">
          <Brain size={12} className="text-accent" />
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            Meeting Intelligence
          </span>
          {isExtractingIntelligence && (
            <Loader2 size={10} className="text-accent animate-spin" />
          )}
          {!hasAnyData && !isExtractingIntelligence && (
            <span className="text-text-faint text-xs">— listening…</span>
          )}
        </div>
        {collapsed ? <ChevronDown size={12} className="text-text-faint" /> : <ChevronUp size={12} className="text-text-faint" />}
      </button>

      {!collapsed && hasAnyData && (
        <div className="grid grid-cols-4 gap-0 border-t border-border">
          {SECTION_CONFIG.map(({ key, label, dot }, idx) => {
            const items = intelligenceSummary?.[key] ?? []
            return (
              <div
                key={key}
                className={`px-4 py-2.5 ${idx < 3 ? 'border-r border-border' : ''}`}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                    {label}
                  </span>
                </div>
                {items.length === 0 ? (
                  <p className="text-text-faint text-xs italic">None yet</p>
                ) : (
                  <ul className="space-y-1">
                    {items.map((item, i) => (
                      <li key={i} className="text-xs text-text-secondary leading-snug flex items-start gap-1.5">
                        <span className="text-text-faint flex-shrink-0 mt-px">·</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
