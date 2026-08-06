import { describe, expect, test } from "bun:test"

import {
  primeWindsurfStream,
  WindsurfFirstFrameTimeoutError,
  withWindsurfStreamCleanup,
} from "~/services/windsurf/stream-start"

async function* immediateSource(): AsyncIterableIterator<string> {
  await Promise.resolve()
  yield "first"
  yield "second"
}

describe("Windsurf stream start", () => {
  test("preserves the primed event and the remaining stream", async () => {
    const primed = await primeWindsurfStream(immediateSource(), {
      timeoutMs: 100,
    })
    const values: Array<string> = []
    for await (const value of primed) values.push(value)
    expect(values).toEqual(["first", "second"])
  })

  test("times out, runs cancellation, and closes the source", async () => {
    let cancelled = false
    let closed = false
    async function* source() {
      try {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000)
          const poll = setInterval(() => {
            if (!cancelled) return
            clearTimeout(timer)
            clearInterval(poll)
            resolve()
          }, 1)
        })
        yield "late"
      } finally {
        closed = true
      }
    }

    let failure: unknown
    try {
      await primeWindsurfStream(source(), {
        timeoutMs: 10,
        onTimeout: () => {
          cancelled = true
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WindsurfFirstFrameTimeoutError)
    expect(cancelled).toBe(true)
    expect(closed).toBe(true)
  })

  test("cleanup runs once when downstream stops after first output", async () => {
    let cleanups = 0
    const wrapped = withWindsurfStreamCleanup(immediateSource(), () => {
      cleanups++
    })

    for await (const value of wrapped) {
      expect(value).toBe("first")
      break
    }
    expect(cleanups).toBe(1)
  })
})
