'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import { Mic, MicOff, Copy, Check } from 'lucide-react'
import { useMeetingStore } from '@/lib/store'
import { transcribeAudio } from '@/lib/transcription'
import { generateId, formatTimestamp } from '@/lib/utils'

const CHUNK_INTERVAL_MS = 5000
const MIN_FRAGMENT_CHARS = 40

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

export default function TranscriptPanel() {
  const {
    isRecording,
    transcript,
    setIsRecording,
    setSessionStartTime,
    addTranscriptChunk,
    appendToLastTranscriptChunk,
    apiKey,
  } = useMeetingStore()

  const transcriptRef = useRef(transcript)
  useEffect(() => { transcriptRef.current = transcript }, [transcript])

  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mimeTypeRef = useRef('')
  const [error, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [transcript.length])

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const transcribeCurrentChunks = useCallback(async (mimeType: string) => {
    if (chunksRef.current.length === 0) return
    const blob = new Blob(chunksRef.current, { type: mimeType })
    chunksRef.current = []
    if (blob.size < 500) return
    try {
      setIsProcessing(true)
      const text = await transcribeAudio(blob, apiKey, mimeType)
      const cleaned = text.trim()
      if (cleaned) {
        // Merge short fragments into the previous chunk for readability
        if (cleaned.length < MIN_FRAGMENT_CHARS && transcriptRef.current.length > 0) {
          appendToLastTranscriptChunk(cleaned)
        } else {
          addTranscriptChunk({
            id: generateId(),
            text: cleaned,
            timestamp: formatTimestamp(new Date()),
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transcription failed'
      setError(msg)
      setTimeout(() => setError(null), 4000)
    } finally {
      setIsProcessing(false)
    }
  }, [apiKey, addTranscriptChunk, appendToLastTranscriptChunk])

  const cycleRecorder = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || !activeRef.current) return

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = async () => {
      await transcribeCurrentChunks(mimeTypeRef.current)
      if (!activeRef.current || !streamRef.current) return

      const next = new MediaRecorder(streamRef.current, {
        mimeType: mimeTypeRef.current || undefined,
      })
      mediaRecorderRef.current = next
      next.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      next.onstop = recorder.onstop
      next.start()
      timerRef.current = setTimeout(cycleRecorder, CHUNK_INTERVAL_MS)
    }
    recorder.stop()
  }, [transcribeCurrentChunks])

  const startRecording = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      activeRef.current = true

      const mimeType = getBestMimeType()
      mimeTypeRef.current = mimeType

      const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined })
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.start()
      setIsRecording(true)
      setSessionStartTime(Date.now())
      timerRef.current = setTimeout(cycleRecorder, CHUNK_INTERVAL_MS)
    } catch {
      setError('Microphone access denied. Please allow microphone permission and try again.')
    }
  }, [cycleRecorder, setIsRecording, setSessionStartTime])

  const stopRecording = useCallback(async () => {
    activeRef.current = false
    if (timerRef.current) clearTimeout(timerRef.current)

    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.onstop = async () => {
          await transcribeCurrentChunks(mimeTypeRef.current)
          resolve()
        }
        recorder.stop()
      })
    }

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null
    setIsRecording(false)
  }, [transcribeCurrentChunks, setIsRecording])

  return (
    <div className="flex flex-col h-full bg-surface-primary">
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
        {isProcessing && (
          <span className="text-xs text-accent animate-pulse">Transcribing…</span>
        )}
      </div>

      {/* Waveform — only while recording */}
      {isRecording && (
        <div className="flex items-center justify-center py-2 bg-accent-bg border-b border-accent-border">
          <Waveform />
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Transcript chunks */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {transcript.length === 0 ? (
          <p className="text-text-faint text-xs text-center mt-12">
            {isRecording ? 'Listening… first chunk in ~3s' : 'Press the mic button to start transcribing'}
          </p>
        ) : (
          transcript.map((chunk) => (
            <div
              key={chunk.id}
              className="group bg-surface-primary rounded-xl px-3 py-2.5 border border-border hover:border-accent-border transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-text-secondary text-sm leading-relaxed flex-1">{chunk.text}</p>
                <button
                  onClick={() => handleCopy(chunk.id, chunk.text)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-text-faint hover:text-accent transition-all rounded flex-shrink-0 mt-0.5"
                  title="Copy"
                >
                  {copied === chunk.id ? <Check size={11} className="text-accent" /> : <Copy size={11} />}
                </button>
              </div>
              <p className="text-text-faint text-xs mt-1">{chunk.timestamp}</p>
            </div>
          ))
        )}
      </div>

      {/* Mic button docked at bottom */}
      <div className="flex items-center justify-center p-4 border-t border-border bg-surface-secondary flex-shrink-0">
        <button
          onClick={isRecording ? stopRecording : startRecording}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all shadow-sm ${
            isRecording
              ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200'
              : 'bg-accent hover:bg-accent-hover text-text-on-accent shadow-lime-200'
          }`}
        >
          {isRecording ? <MicOff size={15} /> : <Mic size={15} />}
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>
      </div>
    </div>
  )
}
