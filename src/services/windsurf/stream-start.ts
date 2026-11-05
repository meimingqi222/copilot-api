export class WindsurfFirstFrameTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Windsurf first frame timed out after ${timeoutMs}ms`)
    this.name = "WindsurfFirstFrameTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export class WindsurfStreamIdleTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Windsurf stream idle timed out after ${timeoutMs}ms`)
    this.name = "WindsurfStreamIdleTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

interface PrimeStreamOptions {
  timeoutMs: number
  idleTimeoutMs?: number
  onTimeout?: (
    error: WindsurfFirstFrameTimeoutError | WindsurfStreamIdleTimeoutError,
  ) => void
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

  async function read(first: boolean): Promise<IteratorResult<T>> {
    const timeoutMs = first ? options.timeoutMs : (options.idleTimeoutMs ?? 0)
    let timer: ReturnType<typeof setTimeout> | undefined
    let timeoutError:
      | WindsurfFirstFrameTimeoutError
      | WindsurfStreamIdleTimeoutError
      | undefined
    try {
      const pending = iterator.next()
      if (timeoutMs === 0) return await pending
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error =
            first ?
              new WindsurfFirstFrameTimeoutError(timeoutMs)
            : new WindsurfStreamIdleTimeoutError(timeoutMs)
          timeoutError = error
          reject(error)
          options.onTimeout?.(error)
        }, timeoutMs)
      })
      return await Promise.race([pending, timeout])
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
  }

  const first = await read(true)

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
          return read(false)
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
