/** 可中断的延时：信号中止时以 AbortError 拒绝，避免轮询循环继续跑。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const onAbort = (sig: AbortSignal) => {
      clearTimeout(timer)
      sig.removeEventListener("abort", boundOnAbort)
      reject(abortError(sig))
    }
    const boundOnAbort = onAbort.bind(null, signal as AbortSignal)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", boundOnAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", boundOnAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("Aborted")
  error.name = "AbortError"
  return error
}
