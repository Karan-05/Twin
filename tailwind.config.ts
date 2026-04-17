import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#84cc16',
          dark: '#65a30d',
          hover: '#78b813',
          bg: '#f7fee7',
          mid: '#ecfccb',
          border: '#d9f99d',
        },
        surface: {
          primary: '#ffffff',
          secondary: '#f9fafb',
          tertiary: '#f3f4f6',
        },
        border: {
          DEFAULT: '#f0f0f0',
          strong: '#e5e7eb',
        },
        text: {
          primary: '#111827',
          secondary: '#1f2937',
          muted: '#6b7280',
          faint: '#9ca3af',
          'on-accent': '#1a2e05',
        },
      },
      animation: {
        'wave-bar': 'waveBar 0.8s ease-in-out infinite alternate',
        'typing-dot': 'typingDot 1.2s ease-in-out infinite',
        'slide-in': 'slideIn 0.25s ease-out',
      },
      keyframes: {
        waveBar: {
          '0%': { transform: 'scaleY(0.2)' },
          '100%': { transform: 'scaleY(1)' },
        },
        typingDot: {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
