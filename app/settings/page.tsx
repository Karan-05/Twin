'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, ArrowLeft, Check } from 'lucide-react'
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '@/lib/settings'
import type { AppSettings } from '@/lib/settings'
import { useMeetingStore } from '@/lib/store'

const PROMPT_FIELDS = [
  {
    key: 'liveSuggestionPrompt' as const,
    label: 'Live Suggestion Prompt',
    hint: 'Use {recent_transcript} for transcript context',
  },
  {
    key: 'clickDetailPrompt' as const,
    label: 'Click-to-Chat Detail Prompt',
    hint: 'Use {full_transcript}, {suggestion_title}, {suggestion_detail}, {suggestion_say}, {suggestion_why_now}, {suggestion_listen_for}, {suggestion_anchor}',
  },
  {
    key: 'chatSystemPrompt' as const,
    label: 'Chat System Prompt',
    hint: 'Use {full_transcript} for full meeting context',
  },
] as const

export default function SettingsPage() {
  const router = useRouter()
  const { setSettings, setApiKey: setStoreApiKey } = useMeetingStore()
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hasExisting, setHasExisting] = useState(false)
  const [settings, setLocalSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    const existing = localStorage.getItem('groq_api_key')
    if (existing) {
      setHasExisting(true)
      setApiKey(existing)
    }
    setLocalSettings(loadSettings())
  }, [])

  const handleSave = () => {
    const trimmedKey = apiKey.trim()
    if (trimmedKey) {
      localStorage.setItem('groq_api_key', trimmedKey)
    } else {
      localStorage.removeItem('groq_api_key')
    }
    saveSettings(settings)
    setStoreApiKey(trimmedKey)
    setSettings(settings)
    setSaved(true)
    setTimeout(() => router.push('/'), 800)
  }

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSaved(false)
    setLocalSettings((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="min-h-screen bg-surface-secondary flex items-start justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-2xl">
        <button
          type="button"
          onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-text-muted hover:text-text-primary text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={14} />
          {hasExisting ? 'Back to meeting' : 'Go to app'}
        </button>

        <div className="bg-surface-primary border border-border-strong rounded-2xl p-8 space-y-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-8 h-8 bg-accent rounded-lg flex items-center justify-center">
                <span className="text-text-on-accent font-bold text-base">M</span>
              </div>
              <h1 className="text-xl font-bold text-text-primary">MeetingCopilot Settings</h1>
            </div>
            <p className="text-text-muted text-sm mt-1">Configure your API key and AI prompts</p>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-2">Groq API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="gsk_..."
                className="w-full bg-surface-tertiary border border-border-strong focus:border-accent text-text-primary rounded-xl px-4 py-3 pr-10 text-sm outline-none transition-colors placeholder-text-faint"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition-colors"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-text-faint text-xs mt-1.5">
              Get your key at{' '}
              <span className="text-accent font-medium">console.groq.com</span>
              {' '}· Stored locally, never sent anywhere except Groq
            </p>
          </div>

          {/* Context windows */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-text-primary mb-1">
                Suggestion context window
              </label>
              <p className="text-text-faint text-xs mb-2">Recent transcript segments to include</p>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.suggestionContextWindow}
                onChange={(e) =>
                  updateSetting('suggestionContextWindow', parseInt(e.target.value, 10) || 5)
                }
                className="w-full bg-surface-tertiary border border-border-strong focus:border-accent text-text-primary rounded-xl px-4 py-2.5 text-sm outline-none transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-text-primary mb-1">
                Detail answer context window
              </label>
              <p className="text-text-faint text-xs mb-2">Segments for click-to-chat (0 = full transcript)</p>
              <input
                type="number"
                min={0}
                max={100}
                value={settings.detailContextWindow}
                onChange={(e) =>
                  updateSetting('detailContextWindow', parseInt(e.target.value, 10) || 0)
                }
                className="w-full bg-surface-tertiary border border-border-strong focus:border-accent text-text-primary rounded-xl px-4 py-2.5 text-sm outline-none transition-colors"
              />
            </div>
          </div>

          {/* Prompt editors */}
          {PROMPT_FIELDS.map(({ key, label, hint }) => (
            <div key={key}>
              <label className="block text-sm font-semibold text-text-primary mb-1">{label}</label>
              <p className="text-text-faint text-xs mb-2">{hint}</p>
              <textarea
                value={settings[key]}
                onChange={(e) => updateSetting(key, e.target.value)}
                rows={6}
                className="w-full bg-surface-tertiary border border-border-strong focus:border-accent text-text-primary rounded-xl px-4 py-3 text-xs font-mono outline-none transition-colors resize-y"
              />
              <button
                type="button"
                onClick={() => updateSetting(key, DEFAULT_SETTINGS[key])}
                className="text-xs text-text-faint hover:text-accent transition-colors mt-1"
              >
                Reset to default
              </button>
            </div>
          ))}

          {/* Save */}
          <button
            onClick={handleSave}
            disabled={saved}
            className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-text-on-accent font-semibold py-3 rounded-xl transition-colors"
          >
            {saved ? (
              <>
                <Check size={16} />
                Saved! Redirecting…
              </>
            ) : (
              'Save Settings'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
