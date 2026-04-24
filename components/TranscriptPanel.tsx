'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import { Mic, MicOff, Copy, Check, Monitor } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import type { Sentiment } from '@/lib/store'
import { transcribeAudio, isHallucination } from '@/lib/transcription'
import { classifySentimentBatch } from '@/lib/sentiment'
import { generateId, formatTimestamp } from '@/lib/utils'
import { deriveMeetingState } from '@/lib/meetingState'

const PROVISIONAL_INTERVAL_MS = 5000
const STABLE_COMMIT_INTERVAL_MS = 30000
const MIN_BLOB_BYTES    = 3000    // ~3KB minimum; silence-only WebM is ~1-2KB overhead
const MIN_FRAGMENT_CHARS = 40
const SENTIMENT_DEBOUNCE_MS = 1500
const EVENT_TRIGGER_COOLDOWN_MS = 12000

const LANGUAGES = [
  { code: 'en', label: 'English',    flag: '🇺🇸' },
  { code: 'es', label: 'Spanish',    flag: '🇪🇸' },
  { code: 'fr', label: 'French',     flag: '🇫🇷' },
  { code: 'de', label: 'German',     flag: '🇩🇪' },
  { code: 'pt', label: 'Portuguese', flag: '🇧🇷' },
  { code: 'hi', label: 'Hindi',      flag: '🇮🇳' },
  { code: 'ja', label: 'Japanese',   flag: '🇯🇵' },
  { code: 'zh', label: 'Chinese',    flag: '🇨🇳' },
  { code: 'ar', label: 'Arabic',     flag: '🇦🇪' },
  { code: 'it', label: 'Italian',    flag: '🇮🇹' },
]

const SENTIMENT_CONFIG: Record<Sentiment, { dot: string; label: string }> = {
  positive:  { dot: 'bg-lime-400',   label: 'Positive' },
  neutral:   { dot: 'bg-slate-300',  label: 'Neutral' },
  tense:     { dot: 'bg-amber-400',  label: 'Tense' },
  confused:  { dot: 'bg-violet-400', label: 'Uncertain' },
}

const MEETING_TYPES = [
  { label: 'Sales Call',         emoji: '💼' },
  { label: 'Job Interview',      emoji: '🎯' },
  { label: 'Standup',            emoji: '⚡' },
  { label: '1:1',                emoji: '🤝' },
  { label: 'Brainstorm',         emoji: '💡' },
  { label: 'Customer Discovery', emoji: '🔍' },
  { label: 'Investor Pitch',     emoji: '🚀' },
  { label: 'Board Meeting',      emoji: '🏛️' },
  { label: 'Team Review',        emoji: '📊' },
  { label: 'Other',              emoji: '💬' },
]

const USER_ROLES: Record<string, string[]> = {
  'Sales Call':         ['Seller', 'Buyer', 'Account Executive', 'Sales Manager'],
  'Job Interview':      ['Interviewer', 'Candidate', 'Hiring Manager', 'Recruiter'],
  'Standup':            ['Engineer', 'Tech Lead', 'Product Manager', 'Scrum Master'],
  '1:1':                ['Manager', 'Direct Report', 'Peer', 'Mentor'],
  'Brainstorm':         ['Facilitator', 'Participant', 'Decision Maker', 'Domain Expert'],
  'Customer Discovery': ['Researcher', 'Customer', 'Product Manager', 'Founder'],
  'Investor Pitch':     ['Founder', 'Investor', 'Advisor', 'Co-founder'],
  'Board Meeting':      ['Board Member', 'CEO', 'CFO', 'Observer'],
  'Team Review':        ['Manager', 'Engineer', 'Designer', 'Product Manager'],
  'Other':              ['Presenter', 'Attendee', 'Facilitator', 'Note Taker'],
}

function getBestMimeType(): string {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ]
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

function Waveform() {
  return (
    <div className="flex items-center gap-[2px] h-5">
      {Array.from({ length: 20 }, (_, i) => (
        <div
          key={i}
          className="w-[2px] bg-accent rounded-full origin-center animate-wave-bar"
          style={{
            height: '100%',
            animationDelay: `${(i * 0.04).toFixed(2)}s`,
            animationDuration: `${0.6 + (i % 5) * 0.08}s`,
          }}
        />
      ))}
    </div>
  )
}

function Pill({
  label,
  selected,
  onClick,
  prefix,
}: {
  label: string
  selected: boolean
  onClick: () => void
  prefix?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium
        transition-all duration-150 whitespace-nowrap
        ${selected
          ? 'bg-accent-bg border-accent text-accent-dark shadow-sm'
          : 'bg-surface-primary border-border text-text-muted hover:border-accent-border hover:text-text-secondary hover:bg-surface-secondary'
        }
      `}
    >
      {prefix && <span className="text-sm leading-none">{prefix}</span>}
      {label}
    </button>
  )
}

function ContextForm() {
  const { meetingContext, setMeetingContext } = useMeetingStore()
  const [type, setType] = useState(meetingContext.meetingType || '')
  const [role, setRole] = useState(meetingContext.userRole || '')
  const [goal, setGoal] = useState(meetingContext.goal || '')
  const [prepNotes, setPrepNotes] = useState(meetingContext.prepNotes || '')
  const [proofPoints, setProofPoints] = useState(meetingContext.proofPoints || '')
  const [lang, setLang] = useState(meetingContext.language || '')

  const roles = type ? (USER_ROLES[type] ?? USER_ROLES['Other']) : []

  const ctx = (overrides: Partial<{ meetingType: string; userRole: string; goal: string; prepNotes: string; proofPoints: string; language: string }>) =>
    setMeetingContext({ meetingType: type, userRole: role, goal, prepNotes, proofPoints, language: lang, ...overrides })

  const handleTypeClick = (val: string) => {
    const next = val === type ? '' : val
    setType(next)
    setRole('')
    ctx({ meetingType: next, userRole: '' })
  }

  const handleRoleClick = (val: string) => {
    const next = val === role ? '' : val
    setRole(next)
    ctx({ userRole: next })
  }

  const handleGoalChange = (val: string) => {
    setGoal(val)
    ctx({ goal: val })
  }

  const handleLangClick = (code: string) => {
    const next = code === lang ? '' : code
    setLang(next)
    ctx({ language: next })
  }

  const handlePrepNotesChange = (val: string) => {
    setPrepNotes(val)
    ctx({ prepNotes: val })
  }

  const handleProofPointsChange = (val: string) => {
    setProofPoints(val)
    ctx({ proofPoints: val })
  }

  return (
    <div className="mx-3 mt-3 mb-1 rounded-xl border border-border bg-surface-secondary overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
          Meeting Context
        </span>
        <span className="ml-auto text-[10px] text-text-faint">
          Sharpens suggestions
        </span>
      </div>

      <div className="px-3.5 pb-3.5 space-y-3">
        {/* Meeting type — pill grid */}
        <div>
          <p className="text-[10px] text-text-faint mb-1.5">What kind of meeting?</p>
          <div className="flex flex-wrap gap-1.5">
            {MEETING_TYPES.map(({ label, emoji }) => (
              <Pill
                key={label}
                label={label}
                prefix={emoji}
                selected={type === label}
                onClick={() => handleTypeClick(label)}
              />
            ))}
          </div>
        </div>

        {/* Role — revealed after type selected */}
        {type && roles.length > 0 && (
          <div className="animate-slide-in">
            <p className="text-[10px] text-text-faint mb-1.5">Your role</p>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <Pill
                  key={r}
                  label={r}
                  selected={role === r}
                  onClick={() => handleRoleClick(r)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Goal — always shown */}
        <div>
          <p className="text-[10px] text-text-faint mb-1.5">Your goal <span className="text-text-faint opacity-60">(optional)</span></p>
          <input
            type="text"
            value={goal}
            onChange={(e) => handleGoalChange(e.target.value)}
            placeholder={
              type === 'Sales Call' ? 'e.g. Qualify budget and close next steps' :
              type === 'Job Interview' ? 'e.g. Assess system design depth and culture fit' :
              type === 'Investor Pitch' ? 'e.g. Get a term sheet commitment or clear next step' :
              'e.g. What you want to achieve by end of this meeting'
            }
            className="w-full bg-surface-primary border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-secondary placeholder-text-faint focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-text-faint">Meeting prep <span className="text-text-faint opacity-60">(session only)</span></p>
            <span className="text-[9px] text-text-faint opacity-70">Participants · agenda · objections</span>
          </div>
          <textarea
            value={prepNotes}
            onChange={(e) => handlePrepNotesChange(e.target.value)}
            rows={3}
            placeholder={
              type === 'Sales Call' ? 'e.g. Buyer = Ops lead + finance reviewer. Biggest risk: they think onboarding will drag.' :
              type === 'Job Interview' ? 'e.g. Interviewer is eng manager. Want to test team autonomy, pace, and culture.' :
              type === 'Board Meeting' ? 'e.g. Need to keep discussion strategic: roadmap tradeoff, retention, AI leverage.' :
              'e.g. Add agenda, participants, known constraints, or context not spoken aloud yet'
            }
            className="w-full bg-surface-primary border border-border rounded-lg px-2.5 py-2 text-xs text-text-secondary placeholder-text-faint focus:outline-none focus:border-accent transition-colors resize-y"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-text-faint">Proof points I can use <span className="text-text-faint opacity-60">(session only)</span></p>
            <span className="text-[9px] text-text-faint opacity-70">metrics · examples · customer evidence</span>
          </div>
          <textarea
            value={proofPoints}
            onChange={(e) => handleProofPointsChange(e.target.value)}
            rows={2}
            placeholder="e.g. Onboarded Acme in 12 days · resolved P1 in 2 hours · grew ARR 12% MoM for 4 months"
            className="w-full bg-surface-primary border border-border rounded-lg px-2.5 py-2 text-xs text-text-secondary placeholder-text-faint focus:outline-none focus:border-accent transition-colors resize-y"
          />
        </div>

        {/* Language — compact pill row */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] text-text-faint">Language</p>
            {lang && (
              <button
                onClick={() => handleLangClick(lang)}
                className="text-[9px] text-text-faint hover:text-accent transition-colors"
              >
                Auto-detect
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {LANGUAGES.map(({ code, label, flag }) => (
              <Pill
                key={code}
                label={label}
                prefix={flag}
                selected={lang === code}
                onClick={() => handleLangClick(code)}
              />
            ))}
          </div>
          {!lang && (
            <p className="text-[9px] text-text-faint mt-1 opacity-70">
              Not selected — Whisper auto-detects spoken language
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TranscriptPanel() {
  const {
    isRecording,
    transcript,
    liveTranscriptPreview,
    setIsRecording,
    setSessionStartTime,
    addTranscriptChunk,
    appendToLastTranscriptChunk,
    updateChunkSentiment,
    focusedChunkId,
    setFocusedChunkId,
    apiKey,
    meetingContext,
    setLiveTranscriptPreview,
    setMeetingState,
  } = useMeetingStore()

  const transcriptRef = useRef(transcript)
  useEffect(() => { transcriptRef.current = transcript }, [transcript])

  const apiKeyRef = useRef(apiKey)
  useEffect(() => { apiKeyRef.current = apiKey }, [apiKey])

  const meetingContextRef = useRef(meetingContext)
  useEffect(() => { meetingContextRef.current = meetingContext }, [meetingContext])

  const streamRef = useRef<MediaStream | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const stableBlobPartsRef = useRef<Blob[]>([])
  const provisionalTextsRef = useRef<string[]>([])
  const stableWindowStartedAtRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentimentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRecorderRef = useRef<(continueRecording: boolean) => Promise<void>>(async () => {})
  const commitStableWindowRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const lastProvisionalTaskRef = useRef<Promise<void>>(Promise.resolve())
  const processingCountRef = useRef(0)
  const lastTriggerAtRef = useRef(0)
  const lastTriggerFingerprintRef = useRef('')
  const activeRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mimeTypeRef = useRef('')
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [audioMode, setAudioMode] = useState<'mic' | 'system'>('mic')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [showContextForm, setShowContextForm] = useState(transcript.length === 0)

  useEffect(() => {
    if (isRecording) {
      setShowContextForm(false)
      return
    }

    if (transcript.length === 0) {
      setShowContextForm(true)
    }
  }, [isRecording, transcript.length])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [transcript.length, liveTranscriptPreview])

  // Scroll + highlight when a timestamp citation is clicked in chat
  useEffect(() => {
    if (!focusedChunkId) return
    const el = document.getElementById(`chunk-${focusedChunkId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedId(focusedChunkId)
      const t = setTimeout(() => {
        setHighlightedId(null)
        setFocusedChunkId(null)
      }, 2000)
      return () => clearTimeout(t)
    }
  }, [focusedChunkId, setFocusedChunkId])

  // Debounced sentiment classification — runs 1.5s after transcript changes
  useEffect(() => {
    if (sentimentTimerRef.current) clearTimeout(sentimentTimerRef.current)
    sentimentTimerRef.current = setTimeout(() => {
      const key = apiKeyRef.current
      if (!key) return
      const unclassified = transcriptRef.current.filter((c) => !c.sentiment).slice(-5)
      if (unclassified.length === 0) return
      classifySentimentBatch(unclassified, key)
        .then((results) => results.forEach((r) => updateChunkSentiment(r.id, r.sentiment)))
        .catch(() => {})
    }, SENTIMENT_DEBOUNCE_MS)
  }, [transcript.length, updateChunkSentiment])

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const withProcessing = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    processingCountRef.current += 1
    setIsProcessing(true)
    try {
      return await task()
    } finally {
      processingCountRef.current = Math.max(0, processingCountRef.current - 1)
      if (processingCountRef.current === 0) {
        setIsProcessing(false)
      }
    }
  }, [])

  const updateDerivedState = useCallback((previewText: string) => {
    const state = deriveMeetingState(transcriptRef.current, meetingContextRef.current, previewText)
    setMeetingState(state)

    if (!state.triggerReason) return

    const fingerprint = `${state.triggerReason}:${state.currentQuestion ?? ''}:${state.riskyClaim ?? ''}:${state.blocker ?? ''}:${state.loopStatus ?? ''}`
    const now = Date.now()

    if (fingerprint === lastTriggerFingerprintRef.current) return
    if (now - lastTriggerAtRef.current < EVENT_TRIGGER_COOLDOWN_MS) return

    lastTriggerAtRef.current = now
    lastTriggerFingerprintRef.current = fingerprint
    window.dispatchEvent(
      new CustomEvent('meeting-copilot:suggestion-trigger', {
        detail: { reason: state.triggerReason },
      })
    )
  }, [setMeetingState])

  const commitStableText = useCallback((text: string) => {
    const cleaned = text.trim()
    if (!cleaned || isHallucination(cleaned)) return

    if (cleaned.length < MIN_FRAGMENT_CHARS && transcriptRef.current.length > 0) {
      appendToLastTranscriptChunk(cleaned)
      return
    }

    addTranscriptChunk({
      id: generateId(),
      text: cleaned,
      timestamp: formatTimestamp(new Date()),
    })
  }, [addTranscriptChunk, appendToLastTranscriptChunk])

  const commitStableWindow = useCallback(async (force = false) => {
    const previewText = provisionalTextsRef.current.join(' ').trim()
    const blobParts = [...stableBlobPartsRef.current]
    const startedAt = stableWindowStartedAtRef.current
    if (blobParts.length === 0 && !previewText) return
    if (!force && startedAt && Date.now() - startedAt < STABLE_COMMIT_INTERVAL_MS) return

    stableBlobPartsRef.current = []
    provisionalTextsRef.current = []
    stableWindowStartedAtRef.current = Date.now()
    setLiveTranscriptPreview('')
    setMeetingState(deriveMeetingState(transcriptRef.current, meetingContextRef.current, ''))

    if (blobParts.length === 0) {
      if (previewText) commitStableText(previewText)
      return
    }

    const blob = new Blob(blobParts, { type: mimeTypeRef.current || 'audio/webm' })
    if (blob.size < MIN_BLOB_BYTES) {
      if (previewText) commitStableText(previewText)
      return
    }

    try {
      const lastChunk = transcriptRef.current[transcriptRef.current.length - 1]
      const text = await withProcessing(() => transcribeAudio(
        blob,
        apiKeyRef.current,
        mimeTypeRef.current,
        meetingContextRef.current.language || undefined,
        lastChunk?.text
      ))
      const cleaned = text.trim()
      if (cleaned && !isHallucination(cleaned)) {
        commitStableText(cleaned)
      } else if (previewText) {
        commitStableText(previewText)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Stable transcript commit failed'
      setError(msg)
      setTimeout(() => setError(null), 4000)
      if (previewText) commitStableText(previewText)
    }
  }, [commitStableText, setLiveTranscriptPreview, setMeetingState, withProcessing])

  const transcribeProvisionalBlob = useCallback(async (blob: Blob, mimeType: string) => {
    if (blob.size < MIN_BLOB_BYTES) return

    try {
      const priorText = provisionalTextsRef.current[provisionalTextsRef.current.length - 1]
        || transcriptRef.current[transcriptRef.current.length - 1]?.text
      const text = await withProcessing(() => transcribeAudio(
        blob,
        apiKeyRef.current,
        mimeType,
        meetingContextRef.current.language || undefined,
        priorText
      ))
      const cleaned = text.trim()
      if (!cleaned || isHallucination(cleaned)) return

      provisionalTextsRef.current.push(cleaned)
      const previewText = provisionalTextsRef.current.join(' ')
      setLiveTranscriptPreview(previewText)
      updateDerivedState(previewText)

      if (stableWindowStartedAtRef.current && Date.now() - stableWindowStartedAtRef.current >= STABLE_COMMIT_INTERVAL_MS) {
        void commitStableWindow(true)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Provisional transcription failed'
      setError(msg)
      setTimeout(() => setError(null), 4000)
    }
  }, [commitStableWindow, setLiveTranscriptPreview, updateDerivedState, withProcessing])

  const restartRecorder = useCallback(() => {
    if (!activeRef.current || !streamRef.current) return

    const next = new MediaRecorder(streamRef.current, {
      mimeType: mimeTypeRef.current || undefined,
    })

    mediaRecorderRef.current = next
    next.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    next.start()
    timerRef.current = setTimeout(() => {
      void flushRecorderRef.current(true)
    }, PROVISIONAL_INTERVAL_MS)
  }, [])

  const flushRecorder = useCallback(async (continueRecording: boolean) => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    if (timerRef.current) clearTimeout(timerRef.current)

    await new Promise<void>((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 0) {
          stableBlobPartsRef.current.push(blob)
        }

        if (continueRecording && activeRef.current && streamRef.current) {
          restartRecorder()
        } else {
          mediaRecorderRef.current = null
        }

        const provisionalTask = transcribeProvisionalBlob(blob, mimeTypeRef.current)
        lastProvisionalTaskRef.current = provisionalTask
        void provisionalTask
        resolve()
      }

      recorder.stop()
    })
  }, [restartRecorder, transcribeProvisionalBlob])

  const cycleRecorder = useCallback(() => {
    if (!activeRef.current) return
    void flushRecorder(true)
  }, [flushRecorder])

  useEffect(() => {
    flushRecorderRef.current = flushRecorder
  }, [flushRecorder])

  useEffect(() => {
    commitStableWindowRef.current = commitStableWindow
  }, [commitStableWindow])

  const getMixedStream = useCallback(async (): Promise<MediaStream> => {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (audioMode === 'mic') return micStream
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: false,
      } as MediaStreamConstraints)
      systemStreamRef.current = displayStream
      const ctx = new AudioContext()
      const dest = ctx.createMediaStreamDestination()
      ctx.createMediaStreamSource(micStream).connect(dest)
      if (displayStream.getAudioTracks().length > 0) {
        ctx.createMediaStreamSource(displayStream).connect(dest)
      }
      return dest.stream
    } catch {
      return micStream
    }
  }, [audioMode])

  const startRecording = useCallback(async () => {
    setError(null)
    if (!apiKeyRef.current) {
      setError('Add your Groq API key in Settings before recording.')
      return
    }
    try {
      const stream = await getMixedStream()
      streamRef.current = stream
      activeRef.current = true
      chunksRef.current = []
      stableBlobPartsRef.current = []
      provisionalTextsRef.current = []
      stableWindowStartedAtRef.current = Date.now()
      lastTriggerAtRef.current = 0
      lastTriggerFingerprintRef.current = ''
      setLiveTranscriptPreview('')
      setMeetingState(deriveMeetingState(transcriptRef.current, meetingContextRef.current, ''))

      const mimeType = getBestMimeType()
      mimeTypeRef.current = mimeType

      const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.start()
      setIsRecording(true)
      setSessionStartTime(Date.now())
      timerRef.current = setTimeout(cycleRecorder, PROVISIONAL_INTERVAL_MS)
    } catch {
      setError('Microphone access denied. Please allow microphone permission and try again.')
    }
  }, [cycleRecorder, getMixedStream, setIsRecording, setLiveTranscriptPreview, setMeetingState, setSessionStartTime])

  const stopRecording = useCallback(async () => {
    activeRef.current = false
    if (timerRef.current) clearTimeout(timerRef.current)

    await flushRecorder(false)
    await lastProvisionalTaskRef.current
    await commitStableWindow(true)

    streamRef.current?.getTracks().forEach((t) => t.stop())
    systemStreamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    systemStreamRef.current = null
    mediaRecorderRef.current = null
    setLiveTranscriptPreview('')
    setMeetingState(deriveMeetingState(transcriptRef.current, meetingContextRef.current, ''))
    setIsRecording(false)
  }, [commitStableWindow, flushRecorder, setIsRecording, setLiveTranscriptPreview, setMeetingState])

  useEffect(() => {
    const handleFlushRequest = async (event: Event) => {
      const { requestId } = (event as CustomEvent<{ requestId: string }>).detail
      let error: string | undefined

      try {
        if (activeRef.current) {
          await flushRecorder(true)
          await lastProvisionalTaskRef.current
          await commitStableWindowRef.current(true)
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Transcript refresh failed'
      }

      window.dispatchEvent(
        new CustomEvent('meeting-copilot:transcript-flushed', {
          detail: { requestId, error },
        })
      )
    }

    window.addEventListener('meeting-copilot:flush-transcript', handleFlushRequest)
    return () => window.removeEventListener('meeting-copilot:flush-transcript', handleFlushRequest)
  }, [flushRecorder])

  const contextSet = meetingContext.meetingType || meetingContext.userRole || meetingContext.prepNotes

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-primary">
      {/* Column header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-secondary flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Transcript</h2>
          {transcript.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 bg-accent-bg text-accent-dark font-medium rounded-full">
              {transcript.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isRecording && transcript.length > 0 && (
            <button
              type="button"
              onClick={() => setShowContextForm((value) => !value)}
              className="text-[11px] text-text-faint hover:text-text-primary transition-colors"
            >
              {showContextForm ? 'Hide context' : 'Edit context'}
            </button>
          )}
          {isProcessing && (
            <span className="text-xs text-accent animate-pulse">Transcribing…</span>
          )}
        </div>
      </div>

      {/* Context form — only shown when not recording.
          Bounded to 40vh when transcript exists so chunks stay visible. */}
      {!isRecording && showContextForm && (
        <div className={`flex-shrink-0${transcript.length > 0 ? ' max-h-[40vh] overflow-y-auto' : ''}`}>
          <ContextForm />
        </div>
      )}

      {/* Active context pill while recording */}
      {isRecording && contextSet && (
        <div className="mx-3 mt-2 px-3 py-1.5 bg-accent-bg border border-accent-border rounded-lg flex items-center gap-2">
          <span className="w-1.5 h-1.5 bg-accent rounded-full flex-shrink-0 animate-pulse" />
          <span className="text-xs text-accent-dark font-medium truncate">
            {meetingContext.meetingType}
            {meetingContext.userRole ? ` · ${meetingContext.userRole}` : ''}
            {meetingContext.goal ? ` — "${meetingContext.goal}"` : ''}
            {!meetingContext.goal && meetingContext.prepNotes ? ' — Prep saved' : ''}
          </span>
        </div>
      )}

      {/* Waveform while recording */}
      {isRecording && (
        <div className="flex items-center justify-center py-2.5 bg-accent-bg border-b border-accent-border mt-2">
          <Waveform />
        </div>
      )}

      {error && (
        <div className="mx-3 mt-2 px-3 py-2 bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg">
          {error}
        </div>
      )}

      {isRecording && liveTranscriptPreview && (
        <div className="mx-3 mt-2 px-3 py-2.5 bg-sky-50 border border-sky-200 rounded-xl">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-sky-700">Live Preview</span>
            <span className="text-[10px] text-sky-600">refreshes ~every 5s · commits ~every 30s</span>
          </div>
          <p className="text-sm text-sky-950 leading-relaxed">{liveTranscriptPreview}</p>
        </div>
      )}

      {/* Transcript chunks */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {transcript.length === 0 && !liveTranscriptPreview ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 mt-4">
            <p className="text-text-faint text-xs text-center">
              {isRecording
                ? 'Listening… live preview in ~5s · stable chunk in ~30s'
                : 'Set context above, then press mic to start'}
            </p>
          </div>
        ) : (
          transcript.map((chunk) => {
            const sentCfg = chunk.sentiment ? SENTIMENT_CONFIG[chunk.sentiment] : null
            return (
              <div
                key={chunk.id}
                id={`chunk-${chunk.id}`}
                className={`group bg-surface-primary rounded-xl px-3 py-2.5 border transition-colors ${
                  highlightedId === chunk.id
                    ? 'border-amber-400 ring-2 ring-amber-200 bg-amber-50'
                    : 'border-border hover:border-accent-border'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-text-secondary text-sm leading-relaxed flex-1">{chunk.text}</p>
                  <button
                    type="button"
                    onClick={() => handleCopy(chunk.id, chunk.text)}
                    className="opacity-70 md:opacity-0 md:group-hover:opacity-100 p-1 text-text-faint hover:text-accent transition-all rounded flex-shrink-0 mt-0.5"
                    title="Copy transcript chunk"
                    aria-label={`Copy transcript chunk from ${chunk.timestamp}`}
                  >
                    {copied === chunk.id ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <p className="text-text-faint text-xs">{chunk.timestamp}</p>
                  {sentCfg && (
                    <span
                      className={`flex items-center gap-1 text-[9px] font-medium text-text-faint`}
                      title={sentCfg.label}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sentCfg.dot}`} />
                      {sentCfg.label}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Mic button + audio mode */}
      <div className="flex flex-col items-center gap-2 p-4 border-t border-border bg-surface-secondary flex-shrink-0">
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={!isRecording && !apiKey}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium transition-all shadow-sm ${
            isRecording
              ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200'
              : 'bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-text-on-accent shadow-lime-200'
          }`}
        >
          {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>

        {!isRecording && (
          <div className="flex items-center gap-0.5 p-0.5 bg-surface-primary rounded-full border border-border">
            <button
              type="button"
              onClick={() => setAudioMode('mic')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                audioMode === 'mic'
                  ? 'bg-accent-bg text-accent-dark border border-accent-border shadow-sm'
                  : 'text-text-faint hover:text-text-muted'
              }`}
            >
              <Mic size={10} />
              Mic only
            </button>
            <button
              type="button"
              onClick={() => setAudioMode('system')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                audioMode === 'system'
                  ? 'bg-accent-bg text-accent-dark border border-accent-border shadow-sm'
                  : 'text-text-faint hover:text-text-muted'
              }`}
              title="Captures tab/system audio (Chrome only)"
            >
              <Monitor size={10} />
              Tab + Mic
            </button>
          </div>
        )}
        {audioMode === 'system' && !isRecording && (
          <p className="text-[10px] text-text-faint">Chrome only · prompts screen share</p>
        )}
        {!apiKey && !isRecording && (
          <p className="text-[10px] text-red-500">Add your Groq API key in Settings before recording.</p>
        )}
      </div>
    </div>
  )
}
