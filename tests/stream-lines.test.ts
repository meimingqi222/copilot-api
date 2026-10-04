import { describe, expect, test } from "bun:test"

import { iterateLines } from "~/lib/stream-lines"

const encoder = new TextEncoder()

async function* fromChunks(chunks: Array<string | Uint8Array>) {
  for (const chunk of chunks) yield chunk
}

async function collect(source: AsyncIterable<string | Uint8Array>) {
  const lines: Array<string> = []
  for await (const line of iterateLines(source)) lines.push(line)
  return lines
}

describe("iterateLines", () => {
  test("splits lines and yields a trailing line with no newline", async () => {
    expect(await collect(fromChunks(["a\nb\nc\n"]))).toEqual(["a", "b", "c"])
    expect(await collect(fromChunks(["a\nb"]))).toEqual(["a", "b"])
  })

  test("strips a trailing CR so CRLF parses like LF", async () => {
    expect(await collect(fromChunks(["a\r\nb\r\n"]))).toEqual(["a", "b"])
  })

  test("keeps empty lines, which SSE uses as an event boundary", async () => {
    expect(await collect(fromChunks(["a\n\nb\n"]))).toEqual(["a", "", "b"])
  })

  test("reassembles a line split across chunks", async () => {
    expect(await collect(fromChunks(['{"a"', ':1}\n{"b":2}\n']))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  test("decodes a multi-byte character split across chunks", async () => {
    const bytes = encoder.encode("héllo\n")
    expect(
      await collect(fromChunks([bytes.slice(0, 2), bytes.slice(2)])),
    ).toEqual(["héllo"])
  })

  test("accepts a ReadableStream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x\ny\n"))
        controller.close()
      },
    })
    expect(await collect(stream)).toEqual(["x", "y"])
  })

  /**
   * The drift this helper exists to remove: the five hand-rolled copies of the
   * split loop had grown different reader cleanup, and only Trae CN cancelled
   * the upstream. A consumer that stops early (error rotation, client
   * disconnect, `[DONE]`) must tear the fetch connection down rather than
   * leaving it parked until GC.
   */
  test("cancels the source stream when the consumer stops early", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("line\n"))
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const _line of iterateLines(stream)) break
    expect(cancelled).toBe(true)
  })

  test("bounds the buffer for a line that never terminates", async () => {
    const iterate = async () => {
      for await (const _line of iterateLines(
        fromChunks(["x".repeat(64), "y".repeat(64)]),
        {
          maxBufferedBytes: 100,
        },
      )) {
        // The source never sends a newline, so nothing is ever yielded.
      }
    }
    await expect(iterate()).rejects.toThrow(/buffer limit/)
  })
})
