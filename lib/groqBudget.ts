const WINDOW_MS = 60_000
const SOFT_TPM_BUDGET = 10000
const SKIP_LOW_PRIORITY = '__groq_skip_low_priority__'
const FALLBACK_HIGH_PRIORITY = '__groq_fallback_high_priority__'
const MAX_HIGH_PRIORITY_WAIT_MS = 6_000

type Priority = 'high' | 'low'

type Reservation = {
  id: string
  at: number
  tokens: number
}

const reservations: Reservation[] = []
let highPriorityChain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pruneReservations(): void {
  const cutoff = Date.now() - WINDOW_MS
  let index = 0
  while (index < reservations.length && reservations[index].at < cutoff) {
    index += 1
  }
  if (index > 0) reservations.splice(0, index)
}

function activeTokenLoad(): number {
  pruneReservations()
  return reservations.reduce((sum, item) => sum + item.tokens, 0)
}

function estimateTokens(promptText: string, maxTokens: number): number {
  const promptTokens = Math.ceil(promptText.length / 4)
  return Math.max(180, promptTokens + maxTokens)
}

function computeWaitMs(estimatedTokens: number): number {
  pruneReservations()
  const currentLoad = activeTokenLoad()
  if (currentLoad + estimatedTokens <= SOFT_TPM_BUDGET) return 0

  let released = 0
  const now = Date.now()
  for (const reservation of reservations) {
    released += reservation.tokens
    if (currentLoad - released + estimatedTokens <= SOFT_TPM_BUDGET) {
      return Math.max(0, reservation.at + WINDOW_MS - now) + 150
    }
  }

  return WINDOW_MS
}

function reserve(estimatedTokens: number): Reservation {
  const reservation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    tokens: estimatedTokens,
  }
  reservations.push(reservation)
  return reservation
}

function release(reservation: Reservation): void {
  const index = reservations.findIndex((item) => item.id === reservation.id)
  if (index >= 0) reservations.splice(index, 1)
}

function parseRateLimitDelayMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const minuteSecondMatch = message.match(/Please try again in\s+([0-9]+)m([0-9.]+)s/i)
  if (minuteSecondMatch) {
    return (Number(minuteSecondMatch[1]) * 60_000) + Math.ceil(Number(minuteSecondMatch[2]) * 1000) + 300
  }

  const secondsMatch = message.match(/Please try again in\s+([0-9.]+)s/i)
  if (secondsMatch) {
    return Math.ceil(Number(secondsMatch[1]) * 1000) + 300
  }

  return message.includes('rate_limit_exceeded') || message.includes('429')
    ? 5_000
    : null
}

async function executeWithBudget<T>(
  promptText: string,
  maxTokens: number,
  priority: Priority,
  fn: () => Promise<T>,
  attempt = 0
): Promise<T> {
  const estimatedTokens = estimateTokens(promptText, maxTokens)
  const waitMs = computeWaitMs(estimatedTokens)

  if (waitMs > 0) {
    if (priority === 'low' && waitMs > 4_000) {
      throw new Error(SKIP_LOW_PRIORITY)
    }
    if (priority === 'high' && waitMs > MAX_HIGH_PRIORITY_WAIT_MS) {
      throw new Error(FALLBACK_HIGH_PRIORITY)
    }
    await sleep(waitMs)
  }

  const reservation = reserve(estimatedTokens)

  try {
    return await fn()
  } catch (error) {
    release(reservation)
    const retryDelay = parseRateLimitDelayMs(error)
    if (retryDelay && attempt < 1) {
      if (priority === 'low' && retryDelay > 4_000) {
        throw new Error(SKIP_LOW_PRIORITY)
      }
      if (priority === 'high' && retryDelay > MAX_HIGH_PRIORITY_WAIT_MS) {
        throw new Error(FALLBACK_HIGH_PRIORITY)
      }
      await sleep(retryDelay)
      return executeWithBudget(promptText, maxTokens, priority, fn, attempt + 1)
    }
    throw error
  }
}

export function isGroqBudgetSkip(error: unknown): boolean {
  return error instanceof Error && error.message === SKIP_LOW_PRIORITY
}

export function isGroqBudgetFallback(error: unknown): boolean {
  return error instanceof Error && error.message === FALLBACK_HIGH_PRIORITY
}

export function withGroqTextBudget<T>(
  promptText: string,
  maxTokens: number,
  priority: Priority,
  fn: () => Promise<T>
): Promise<T> {
  if (priority === 'low') {
    return executeWithBudget(promptText, maxTokens, priority, fn)
  }

  const run = highPriorityChain.then(
    () => executeWithBudget(promptText, maxTokens, priority, fn),
    () => executeWithBudget(promptText, maxTokens, priority, fn)
  )
  highPriorityChain = run.then(() => undefined, () => undefined)
  return run
}
