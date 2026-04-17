import { create } from 'zustand'
import { loadSettings } from './settings'
import type { AppSettings } from './settings'

export interface TranscriptChunk {
  id: string
  text: string
  timestamp: string
}

export type SuggestionType = 'question' | 'talking_point' | 'answer' | 'fact_check' | 'clarification'

export interface Suggestion {
  id: string
  type: SuggestionType
  title: string
  detail: string
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

  setApiKey: (key: string) => void
  setIsRecording: (val: boolean) => void
  setSessionStartTime: (t: number | null) => void
  setNextSuggestionIn: (n: number) => void
  setIsGeneratingSuggestions: (v: boolean) => void
  setIsStreamingChat: (v: boolean) => void
  setSessionTitle: (title: string) => void
  setSettings: (s: AppSettings) => void
  addTranscriptChunk: (chunk: TranscriptChunk) => void
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

  setApiKey: (key) => set({ apiKey: key }),
  setIsRecording: (val) => set({ isRecording: val }),
  setSessionStartTime: (t) => set({ sessionStartTime: t }),
  setNextSuggestionIn: (n) => set({ nextSuggestionIn: n }),
  setIsGeneratingSuggestions: (v) => set({ isGeneratingSuggestions: v }),
  setIsStreamingChat: (v) => set({ isStreamingChat: v }),
  setSessionTitle: (title) => set({ sessionTitle: title }),
  setSettings: (s) => set({ settings: s }),
  addTranscriptChunk: (chunk) =>
    set((s) => ({ transcript: [...s.transcript, chunk] })),
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
    }),
}))
