export class WindsurfFirstFrameTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Windsurf first frame timed out after ${timeoutMs}ms`)
    this.name = "WindsurfFirstFrameTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

interface PrimeStreamOptions {
  timeoutMs: number
  onTimeout?: () => void
}

/**
 * Read one event before returning the iterable. This keeps pre-output failures
 * inside dispatch/failover while preserving the event for the downstream
 * consumer. The timeout is intentionally disabled with zero.
 */
export async function primeWindsurfStream<T>(
  source: AsyncIterable<T>,
  options: PrimeStreamOptions,
): Promise<AsyncIterable<T>> {
  const iterator = source[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutError: WindsurfFirstFrameTimeoutError | undefined

  const firstPromise = iterator.next()
  const first = await (async () => {
    try {
      if (options.timeoutMs === 0) return await firstPromise
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new WindsurfFirstFrameTimeoutError(options.timeoutMs)
          timeoutError = error
          reject(error)
          options.onTimeout?.()
        }, options.timeoutMs)
      })
      return await Promise.race([firstPromise, timeout])
    } catch (error) {
      try {
        await iterator.return?.()
      } catch {
        // Preserve the timeout/upstream error while releasing best-effort.
      }
      throw timeoutError ?? error
    } finally {
      if (timer) clearTimeout(timer)
    }
  })()

  let claimed = false
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      if (claimed) {
        throw new Error("Windsurf response stream can only be consumed once")
      }
      claimed = true
      let firstPending = true
      return {
        async next(): Promise<IteratorResult<T>> {
          if (firstPending) {
            firstPending = false
            return first
          }
          return iterator.next()
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          firstPending = false
          if (iterator.return) return iterator.return(value)
          return { done: true, value: value as T }
        },
        async throw(error?: unknown): Promise<IteratorResult<T>> {
          firstPending = false
          if (iterator.throw) return iterator.throw(error)
          throw error
        },
      }
    },
  }
}

export function withWindsurfStreamCleanup<T>(
  source: AsyncIterable<T>,
  cleanup: () => void,
  onError?: (error: unknown) => void,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
      try {
        yield* source
      } catch (error) {
        onError?.(error)
        throw error
      } finally {
        cleanup()
      }
    },
  }
}
