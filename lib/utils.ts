export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function formatTimestamp(date: Date): string {
  return date.toTimeString().slice(0, 8)
}
