# Meeting Copilot — Production Redesign Spec

**Date:** 2026-04-16  
**Status:** Approved  
**Scope:** Full visual + UX overhaul of the existing Next.js 14 / Tailwind / Zustand app

---

## 1. Design System

### Color Palette — Pure White + Lime Carbon

| Token | Value | Usage |
|---|---|---|
| `bg-primary` | `#ffffff` | Main app background |
| `bg-secondary` | `#f9fafb` | Column headers, panels |
| `bg-tertiary` | `#f3f4f6` | Cards, input backgrounds |
| `border` | `#f0f0f0` | All dividers and borders |
| `border-strong` | `#e5e7eb` | Card outlines, nav borders |
| `accent` | `#84cc16` | Primary CTA, waveform, user bubbles, toggles |
| `accent-dark` | `#65a30d` | Hover states, logo text, column titles |
| `accent-hover` | `#78b813` | Button hover |
| `accent-bg` | `#f7fee7` | Suggestion backgrounds, badge fills |
| `accent-mid` | `#ecfccb` | Hover tints, selection highlights |
| `accent-border` | `#d9f99d` | Accent-adjacent borders |
| `on-accent` | `#1a2e05` | Text on lime backgrounds |
| `text-primary` | `#111827` | Body text |
| `text-secondary` | `#1f2937` | Card text |
| `text-muted` | `#6b7280` | Subtitles, meta |
| `text-faint` | `#9ca3af` | Timestamps, hints |
| `text-placeholder` | `#d1d5db` | Input placeholders |

### Suggestion Type Colors (4 types)

| Type | Background | Left Border | Badge bg | Badge text |
|---|---|---|---|---|
| question | `#f0fdf4` | `#22c55e` | `#dcfce7` | `#16a34a` |
| action | `#fff7ed` | `#f97316` | `#ffedd5` | `#ea580c` |
| insight | `#faf5ff` | `#a855f7` | `#f3e8ff` | `#9333ea` |
| warning | `#fffbeb` | `#eab308` | `#fef9c3` | `#ca8a04` |

### Typography
- Font: System stack — `-apple-system, BlinkMacSystemFont, 'Inter', sans-serif`
- No external font loading (performance)
- Timestamps and waveform labels: `'SF Mono', monospace`

### Border Radius
- App shell: `16px`
- Cards (chunks, suggestion cards, bubbles): `10px`
- Buttons: `7–8px`
- Badges/pills: `20px` (pill) or `4px` (inline)
- Input row: `12px`
- Send button: `8px`
- Column icons: `5–6px`

---

## 2. Layout & Shell

### Top Navigation Bar (52px)
- **Left:** Logo icon (28×28 lime square, rounded, letter "M") + "Meeting**Copilot**" wordmark (accent-dark color on "Copilot")
- **Center:** Session title pill — editable session name + elapsed time ("Q3 Roadmap Sync · 00:04:17"). Clicking opens a rename input. Shows a lime dot when recording.
- **Right:**
  - Live recording badge ("● LIVE · 00:04:17") in red pill — only visible when recording
  - Export button (ghost, icon only)
  - Settings button (ghost, icon only)

### Status Bar (28px, bottom of shell)
- Left: "Groq connected" dot + "Whisper Turbo · ~2s lag"
- Right: session stats — "N transcript segments · N suggestions · N messages"
- Background: `#fafafa`, top border `#f0f0f0`

### 3-Column Layout (fills remaining height)
- Equal thirds (`flex: 1` each)
- Dividers: `1px solid #f0f0f0`
- No padding on the outer shell — columns flush to edges

### Column Header (44px, each column)
- Background: `#fafafa`, bottom border `#f0f0f0`
- Left: emoji icon in `22×22` lime-tinted rounded square + column title (600 weight, `#374151`) + dynamic badge
- Right: icon action buttons (26×26, ghost)

---

## 3. Transcript Panel (Left Column)

### Waveform Bar (36px, below column header)
- Visible only while `isRecording === true`
- 20 animated bars, heights randomised, `#84cc16` color
- CSS `@keyframes` animation — no canvas, no Web Audio API
- "AUDIO" label left, "● LIVE" label right (lime, monospace)
- Background `#f9fafb`, bottom border `#f0f0f0`

### Transcript Body (scrollable)
- Each `TranscriptChunk` renders as a card:
  - Background `#f9fafb`, border `1px solid #f0f0f0`, `border-radius: 10px`
  - Timestamp top-left in monospace (`#9ca3af`)
  - "⎘ copy" top-right, visible only on `hover` (opacity transition)
  - Text: `13px`, `#1f2937`, `line-height: 1.55`
  - On hover: border transitions to `#d9f99d`
- Auto-scroll to bottom on new chunk (smooth)
- Empty state: centered icon + "Press Start to begin transcribing" in `#9ca3af`

### Mic Button (docked at bottom, 40px + 12px margin)
- **Stopped:** lime background (`#84cc16`), dark text, microphone icon, "Start Recording"
- **Recording:** `#fef2f2` background, red text/border, stop icon, "Stop Recording"
- Box shadow on lime state: `0 2px 8px rgba(132,204,22,0.3)`
- Hover: slight lift (`translateY(-1px)`) + deeper shadow

---

## 4. Suggestions Panel (Middle Column)

### Suggestion Cards
- Each card has a 3px left border colored by type (see color table above)
- Background tinted by type
- Header row: type badge (pill) left + copy icon right
- Text: `12.5px`, `#1f2937`, `line-height: 1.5`
- Timestamp: `10px`, `#9ca3af`
- Hover: `box-shadow: 0 2px 8px rgba(0,0,0,0.06)` + `translateX(1px)`
- New cards animate in: `slideInFromBottom` (translate + opacity, 200ms)

### Controls Bar (bottom, 40px)
- Left: auto-suggest toggle (lime track, white thumb)
- Right: "✦ Generate now" button (lime-tinted, accent border)
- Background `#fafafa`, top border `#f0f0f0`

### Badge
- "N new" badge on column header counts suggestions added since last viewed
- Resets when the suggestions panel is scrolled

---

## 5. Chat Panel (Right Column)

### Message Bubbles
- **User:** lime background (`#84cc16`), dark text (`#1a2e05`), `font-weight: 500`, bottom-right radius `4px`, lime shadow
- **Assistant:** `#f9fafb` background, `border: 1px solid #f0f0f0`, bottom-left radius `4px`
- Each message: timestamp below bubble (`10px`, muted)
- Assistant messages: 24×24 "AI" avatar badge (lime-tinted) to the left, docked to bottom of bubble

### Typing Indicator
- 3-dot bounce animation while streaming
- Same bubble style as assistant messages
- Replaced in-place by streamed text as tokens arrive

### Input Area
- Container: `#fafafa` background, top border
- Inner row: white background, `1.5px` border, `border-radius: 12px`
- Focus ring: border transitions to `#84cc16`
- Send button: lime square (`32×32`), dark arrow icon, lime shadow
- Hint text below: "Enter to send · Shift+Enter for new line"

---

## 6. Settings Page

- Centered card on white background (`max-width: 440px`)
- Logo + wordmark at top of card
- API key input: password field, eye toggle, lime focus ring
- Save button: full-width lime, dark text
- "Key saved ✓" green confirmation state before redirect
- Privacy note: "Stored locally in your browser"

---

## 7. Animations & Micro-interactions

| Element | Animation |
|---|---|
| Waveform bars | CSS keyframe loop, staggered delays |
| Recording dot in nav | `scale` + `opacity` pulse, 1.2s |
| New suggestion card | `slideInFromBottom` 200ms ease-out |
| Typing dots | `translateY` bounce, staggered |
| Mic button | `translateY(-1px)` on hover, shadow deepens |
| Suggestion card hover | `translateX(1px)` + shadow |
| Transcript chunk hover | border-color transition to lime |
| Chat input focus | border-color transition to `#84cc16` |
| Toggle switch | `translateX` on thumb, 150ms |

All animations use CSS transitions or `@keyframes`. No JS animation libraries.

---

## 8. Component File Map

| File | Change |
|---|---|
| `app/globals.css` | New CSS custom properties for full token set |
| `tailwind.config.ts` | Extend theme with lime palette + custom tokens |
| `components/MeetingRoom.tsx` | New top nav (session title, timer, live badge, status bar) |
| `components/TranscriptPanel.tsx` | Waveform bar, new chunk cards, hover copy, mic button at bottom |
| `components/SuggestionsPanel.tsx` | New card design, 4-type color system, controls bar, "N new" badge |
| `components/ChatPanel.tsx` | AI avatar, new bubbles, typing indicator, new input area |
| `app/settings/page.tsx` | Redesigned settings card |
| `lib/store.ts` | Add `sessionTitle: string`, `sessionStartTime: number`, `setSessionTitle` |

---

## 9. Out of Scope

The following are explicitly excluded from this redesign to keep the scope buildable in one pass:
- Session history / persistence across page reloads
- Speaker diarisation / speaker labels
- Search within transcript
- Keyboard shortcuts overlay
- Mobile / responsive layout
- Export format options beyond JSON
