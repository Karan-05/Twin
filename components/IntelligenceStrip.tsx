'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronUp, Loader2, Copy, Check, Sparkles, Clock } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { extractIntelligenceSummary } from '@/lib/intelligence'
import { deriveSecondBrainBrief } from '@/lib/secondBrain'

const EXTRACT_INTERVAL_MS = 60_000
const FIRST_EXTRACT_DELAY_MS = 65_000

const SECTION_CONFIG = [
  { key: 'decisions' as const, label: 'Decisions', dot: 'bg-[#22c55e]' },
  { key: 'actionItems' as const, label: 'Action Items', dot: 'bg-[#3b82f6]' },
  { key: 'keyData' as const, label: 'Key Data', dot: 'bg-[#f97316]' },
  { key: 'openQuestions' as const, label: 'Open Questions', dot: 'bg-[#a855f7]' },
]

function CopyButton({ text }: { text: string }) {
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
      className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-faint hover:text-accent ml-auto pl-1"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check size={10} className="text-accent" /> : <Copy size={10} />}
    </button>
  )
}

function hasSummaryData(summary: ReturnType<typeof useMeetingStore.getState>['intelligenceSummary']): boolean {
  return Boolean(summary && (
    summary.overview ||
    summary.decisions.length > 0 ||
    summary.actionItems.length > 0 ||
    summary.keyData.length > 0 ||
    summary.openQuestions.length > 0
  ))
}

export default function IntelligenceStrip() {
  const {
    isRecording,
    transcript,
    apiKey,
    meetingContext,
    meetingState,
    intelligenceSummary,
    isExtractingIntelligence,
    isGeneratingSuggestions,
    isStreamingChat,
    relatedSessions,
    setIntelligenceSummary,
    setIsExtractingIntelligence,
  } = useMeetingStore()

  const [collapsed, setCollapsed] = useState(false)
  const [brainCollapsed, setBrainCollapsed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevRecordingRef = useRef(isRecording)
  const transcriptRef = useRef(transcript)
  const apiKeyRef = useRef(apiKey)
  const meetingContextRef = useRef(meetingContext)
  const isGeneratingSuggestionsRef = useRef(isGeneratingSuggestions)
  const isStreamingChatRef = useRef(isStreamingChat)

  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { apiKeyRef.current = apiKey }, [apiKey])
  useEffect(() => { meetingContextRef.current = meetingContext }, [meetingContext])
  useEffect(() => { isGeneratingSuggestionsRef.current = isGeneratingSuggestions }, [isGeneratingSuggestions])
  useEffect(() => { isStreamingChatRef.current = isStreamingChat }, [isStreamingChat])

  const runExtraction = async () => {
    if (!apiKeyRef.current || transcriptRef.current.length < 2 || isGeneratingSuggestionsRef.current || isStreamingChatRef.current) return
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
    const initial = setTimeout(() => {
      runExtraction()
      timerRef.current = setInterval(runExtraction, EXTRACT_INTERVAL_MS)
    }, FIRST_EXTRACT_DELAY_MS)
    return () => {
      clearTimeout(initial)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording])

  useEffect(() => {
    const wasRecording = prevRecordingRef.current
    prevRecordingRef.current = isRecording
    if (wasRecording && !isRecording && transcript.length >= 2) {
      void runExtraction()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, transcript.length])

  // Derive second-brain brief live from current transcript — no API call
  const brief = useMemo(
    () => transcript.length > 0 ? deriveSecondBrainBrief(transcript.slice(-8), meetingContext, meetingState) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript.length, meetingContext, meetingState]
  )

  const hasAnyData = hasSummaryData(intelligenceSummary)
  const hasBrief = Boolean(brief && (brief.overview || brief.tension || brief.bestMove))
  const hasMemories = relatedSessions.length > 0

  if (!isRecording && !hasAnyData && !hasBrief && !hasMemories) return null

  return (
    <div className="border-t border-border bg-surface-secondary flex-shrink-0">
      {/* ── Intelligence extraction panel ── */}
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
        <div className="border-t border-border">
          {intelligenceSummary?.overview && (
            <div className="px-4 py-3 border-b border-border bg-accent-bg/50">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-accent" />
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                  Overview
                </span>
              </div>
              <p className="text-xs text-text-secondary leading-snug">{intelligenceSummary.overview}</p>
            </div>
          )}
          <div className="grid grid-cols-4 gap-0">
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
                      <li key={i} className="group text-xs text-text-secondary leading-snug flex items-start gap-1.5">
                        <span className="text-text-faint flex-shrink-0 mt-px">·</span>
                        <span className="flex-1">{item}</span>
                        <CopyButton text={item} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          </div>
        </div>
      )}

      {/* ── Second Brain panel ── */}
      {(hasBrief || hasMemories || isRecording) && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setBrainCollapsed((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-2 hover:bg-surface-tertiary transition-colors"
            aria-expanded={!brainCollapsed}
            aria-label={brainCollapsed ? 'Expand second brain' : 'Collapse second brain'}
          >
            <div className="flex items-center gap-2">
              <Sparkles size={12} className="text-violet-500" />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Second Brain
              </span>
              {hasMemories && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 bg-violet-50 border border-violet-200 text-violet-600 rounded-full text-[10px] font-medium">
                  <Clock size={8} />
                  {relatedSessions.length} memor{relatedSessions.length === 1 ? 'y' : 'ies'} recalled
                </span>
              )}
            </div>
            {brainCollapsed ? <ChevronDown size={12} className="text-text-faint" /> : <ChevronUp size={12} className="text-text-faint" />}
          </button>

          {!brainCollapsed && (
            <div className="border-t border-border">
              {/* Live brief */}
              {hasBrief ? (
                <div className="grid grid-cols-3 gap-0 border-b border-border">
                  {brief?.overview && (
                    <div className="px-4 py-2.5 border-r border-border">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-violet-400" />
                        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                          Now
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary leading-snug">{brief.overview}</p>
                    </div>
                  )}
                  {brief?.tension && (
                    <div className="px-4 py-2.5 border-r border-border">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-400" />
                        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                          Tension
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary leading-snug">{brief.tension}</p>
                    </div>
                  )}
                  {brief?.bestMove && (
                    <div className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-emerald-400" />
                        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                          Best Move
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary leading-snug">{brief.bestMove}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-4 py-2.5 border-b border-border">
                  <p className="text-xs text-text-faint italic">Building context from the conversation…</p>
                </div>
              )}

              {/* Memory cards */}
              {hasMemories ? (
                <div className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-violet-400" />
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                      Recalled from past meetings
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {relatedSessions.map((session) => {
                      const dateLabel = new Date(session.date).toLocaleDateString(undefined, {
                        weekday: 'short', month: 'short', day: 'numeric',
                      })
                      const roleLabel = session.userRole ? ` · ${session.userRole}` : ''
                      const typeLabel = session.meetingType ? `${session.meetingType}` : 'Meeting'
                      const topDecision = session.summary.decisions[0]
                      const topAction = session.summary.actionItems[0]
                      const topQuestion = session.summary.openQuestions[0]
                      return (
                        <div
                          key={session.id}
                          className="bg-surface-primary border border-border rounded-lg px-3 py-2.5 space-y-1.5"
                        >
                          <div className="flex items-center gap-1.5">
                            <Clock size={9} className="text-violet-400 flex-shrink-0" />
                            <span className="text-[10px] font-semibold text-violet-500">{typeLabel}{roleLabel}</span>
                            <span className="text-[10px] text-text-faint ml-auto">{dateLabel}</span>
                          </div>
                          {session.summary.overview && (
                            <p className="text-xs text-text-secondary leading-snug">{session.summary.overview}</p>
                          )}
                          {topDecision && (
                            <div className="flex items-start gap-1">
                              <span className="text-[10px] text-emerald-500 font-medium flex-shrink-0 mt-px">Decision:</span>
                              <span className="text-[10px] text-text-secondary">{topDecision}</span>
                            </div>
                          )}
                          {topAction && (
                            <div className="flex items-start gap-1">
                              <span className="text-[10px] text-blue-500 font-medium flex-shrink-0 mt-px">Action:</span>
                              <span className="text-[10px] text-text-secondary">{topAction}</span>
                            </div>
                          )}
                          {topQuestion && (
                            <div className="flex items-start gap-1">
                              <span className="text-[10px] text-violet-500 font-medium flex-shrink-0 mt-px">Still open:</span>
                              <span className="text-[10px] text-text-secondary">{topQuestion}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-2.5">
                  <p className="text-xs text-text-faint italic">
                    No past meetings matched yet. Memories are built as you complete sessions.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
