import { create } from 'zustand'
import { loadSettings } from './settings'
import type { AppSettings } from './settings'
import type { MeetingState } from './meetingState'

export type Sentiment = 'positive' | 'neutral' | 'tense' | 'confused'

export interface TranscriptChunk {
  id: string
  text: string
  timestamp: string
  sentiment?: Sentiment
}

export type SuggestionType = 'question' | 'talking_point' | 'answer' | 'fact_check' | 'clarification'

export interface Suggestion {
  id: string
  type: SuggestionType
  title: string
  detail: string
  say?: string
  whyNow?: string
  listenFor?: string
  score?: number
}

export interface SuggestionBatch {
  id: string
  suggestions: Suggestion[]
  timestamp: string
  transcriptSnapshot: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface MeetingContext {
  meetingType: string
  userRole: string
  goal: string
  prepNotes?: string
  proofPoints?: string
  language?: string
}

export interface IntelligenceSummary {
  decisions: string[]
  actionItems: string[]
  keyData: string[]
  openQuestions: string[]
}

interface MeetingStore {
  apiKey: string
  isRecording: boolean
  transcript: TranscriptChunk[]
  suggestionBatches: SuggestionBatch[]
  messages: Message[]
  sessionTitle: string
  sessionStartTime: number | null
  nextSuggestionIn: number
  isGeneratingSuggestions: boolean
  isStreamingChat: boolean
  settings: AppSettings
  meetingContext: MeetingContext
  liveTranscriptPreview: string
  meetingState: MeetingState
  intelligenceSummary: IntelligenceSummary | null
  isExtractingIntelligence: boolean

  setApiKey: (key: string) => void
  setIsRecording: (val: boolean) => void
  setSessionStartTime: (t: number | null) => void
  setNextSuggestionIn: (n: number) => void
  setIsGeneratingSuggestions: (v: boolean) => void
  setIsStreamingChat: (v: boolean) => void
  setSessionTitle: (title: string) => void
  setSettings: (s: AppSettings) => void
  setMeetingContext: (ctx: MeetingContext) => void
  setLiveTranscriptPreview: (text: string) => void
  setMeetingState: (state: MeetingState) => void
  setIntelligenceSummary: (s: IntelligenceSummary | null) => void
  setIsExtractingIntelligence: (v: boolean) => void
  priorMeetingContext: string | null
  setPriorMeetingContext: (ctx: string | null) => void
  focusedChunkId: string | null
  setFocusedChunkId: (id: string | null) => void
  addTranscriptChunk: (chunk: TranscriptChunk) => void
  appendToLastTranscriptChunk: (text: string) => void
  updateChunkSentiment: (id: string, sentiment: Sentiment) => void
  addSuggestionBatch: (batch: SuggestionBatch) => void
  addMessage: (message: Message) => void
  updateLastMessage: (content: string) => void
  clearSession: () => void
}

export const useMeetingStore = create<MeetingStore>((set) => ({
  apiKey: '',
  isRecording: false,
  transcript: [],
  suggestionBatches: [],
  messages: [],
  sessionTitle: 'Untitled Meeting',
  sessionStartTime: null,
  nextSuggestionIn: 30,
  isGeneratingSuggestions: false,
  isStreamingChat: false,
  settings: loadSettings(),
  meetingContext: { meetingType: '', userRole: '', goal: '', prepNotes: '', proofPoints: '' },
  liveTranscriptPreview: '',
  meetingState: {
    mode: 'probe',
    currentQuestion: null,
    questionIntent: null,
    blocker: null,
    riskyClaim: null,
    decisionFocus: null,
    deadlineSignal: null,
    loopStatus: null,
    stakeholderSignals: [],
    triggerReason: null,
    updatedAt: null,
  },
  intelligenceSummary: null,
  isExtractingIntelligence: false,
  priorMeetingContext: null,
  focusedChunkId: null,

  setApiKey: (key) => set({ apiKey: key }),
  setIsRecording: (val) => set({ isRecording: val }),
  setSessionStartTime: (t) => set({ sessionStartTime: t }),
  setNextSuggestionIn: (n) => set({ nextSuggestionIn: n }),
  setIsGeneratingSuggestions: (v) => set({ isGeneratingSuggestions: v }),
  setIsStreamingChat: (v) => set({ isStreamingChat: v }),
  setSessionTitle: (title) => set({ sessionTitle: title }),
  setSettings: (s) => set({ settings: s }),
  setMeetingContext: (ctx) => set({ meetingContext: ctx }),
  setLiveTranscriptPreview: (text) => set({ liveTranscriptPreview: text }),
  setMeetingState: (meetingState) => set({ meetingState }),
  setIntelligenceSummary: (s) => set({ intelligenceSummary: s }),
  setIsExtractingIntelligence: (v) => set({ isExtractingIntelligence: v }),
  setPriorMeetingContext: (ctx) => set({ priorMeetingContext: ctx }),
  setFocusedChunkId: (id) => set({ focusedChunkId: id }),
  addTranscriptChunk: (chunk) =>
    set((s) => ({ transcript: [...s.transcript, chunk] })),
  appendToLastTranscriptChunk: (text) =>
    set((s) => {
      if (s.transcript.length === 0) return s
      const chunks = [...s.transcript]
      const last = chunks[chunks.length - 1]
      chunks[chunks.length - 1] = { ...last, text: `${last.text} ${text}` }
      return { transcript: chunks }
    }),
  updateChunkSentiment: (id, sentiment) =>
    set((s) => ({
      transcript: s.transcript.map((c) => (c.id === id ? { ...c, sentiment } : c)),
    })),
  addSuggestionBatch: (batch) =>
    set((s) => ({ suggestionBatches: [batch, ...s.suggestionBatches] })),
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  updateLastMessage: (content) =>
    set((s) => {
      const msgs = [...s.messages]
      if (msgs.length > 0)
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content }
      return { messages: msgs }
    }),
  clearSession: () =>
    set({
      transcript: [],
      suggestionBatches: [],
      messages: [],
      isRecording: false,
      sessionStartTime: null,
      nextSuggestionIn: 30,
      sessionTitle: 'Untitled Meeting',
      liveTranscriptPreview: '',
      intelligenceSummary: null,
      meetingContext: { meetingType: '', userRole: '', goal: '', prepNotes: '', proofPoints: '' },
      meetingState: {
        mode: 'probe',
        currentQuestion: null,
        questionIntent: null,
        blocker: null,
        riskyClaim: null,
        decisionFocus: null,
        deadlineSignal: null,
        loopStatus: null,
        stakeholderSignals: [],
        triggerReason: null,
        updatedAt: null,
      },
    }),
}))
