function parseRetryDelayMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const minuteSecondMatch = message.match(/Please try again in\s+([0-9]+)m([0-9.]+)s/i)
  if (minuteSecondMatch) {
    return (Number(minuteSecondMatch[1]) * 60_000) + Math.ceil(Number(minuteSecondMatch[2]) * 1000) + 300
  }

  const secondsMatch = message.match(/Please try again in\s+([0-9.]+)s/i)
  if (secondsMatch) {
    return Math.ceil(Number(secondsMatch[1]) * 1000) + 300
  }

  return null
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  backoffMs = 500
): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < attempts - 1) {
        const retryDelay = parseRetryDelayMs(err)
        const waitMs = retryDelay ?? (backoffMs * Math.pow(2, i))
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }
  throw lastError
}
