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
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, i)))
      }
    }
  }
  throw lastError
}
