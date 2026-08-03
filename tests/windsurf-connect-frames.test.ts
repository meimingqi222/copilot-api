import { describe, expect, test } from "bun:test"

import {
  decodeConnectFrames,
  encodeConnectFrame,
} from "~/services/windsurf/protobuf"

function buildStream(chunks: Array<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

async function collectFrames(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<Uint8Array>> {
  const frames: Array<Uint8Array> = []
  for await (const frame of decodeConnectFrames(stream)) {
    frames.push(frame)
  }
  return frames
}

describe("decodeConnectFrames", () => {
  test("yields uncompressed protobuf frames", async () => {
    const payload = new TextEncoder().encode("hello world")
    const frame = encodeConnectFrame(payload, false)
    const frames = await collectFrames(buildStream([frame]))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe("hello world")
  })

  test("yields compressed protobuf frames", async () => {
    const payload = new TextEncoder().encode("compressed payload")
    const frame = encodeConnectFrame(payload, true)
    const frames = await collectFrames(buildStream([frame]))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe("compressed payload")
  })

  test("skips clean end-of-stream trailer", async () => {
    const payload = new TextEncoder().encode("message")
    const msgFrame = encodeConnectFrame(payload, false)
    const trailerText = "{}"
    const trailerPayload = new TextEncoder().encode(trailerText)
    const trailerFrame = encodeConnectFrame(trailerPayload, false)
    // Patch the flag byte to mark it as an end-of-stream trailer.
    trailerFrame[0] = 0x02

    const frames = await collectFrames(buildStream([msgFrame, trailerFrame]))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe("message")
  })

  test("throws on end-of-stream trailer carrying an error", () => {
    const trailerText = JSON.stringify({
      error: {
        code: "Permission denied",
        message: "Reached message rate limit",
      },
    })
    const trailerPayload = new TextEncoder().encode(trailerText)
    const trailerFrame = encodeConnectFrame(trailerPayload, false)
    trailerFrame[0] = 0x02

    expect(collectFrames(buildStream([trailerFrame]))).rejects.toThrow(
      "Windsurf stream error Permission denied: Reached message rate limit",
    )
  })

  test("throws on compressed end-of-stream trailer carrying an error", () => {
    const trailerText = JSON.stringify({
      error: {
        code: "internal",
        message: "something went wrong",
      },
    })
    const trailerPayload = new TextEncoder().encode(trailerText)
    const trailerFrame = encodeConnectFrame(trailerPayload, true)
    trailerFrame[0] = 0x03

    expect(collectFrames(buildStream([trailerFrame]))).rejects.toThrow(
      "Windsurf stream error internal: something went wrong",
    )
  })

  test("rejects oversized declared frame length", () => {
    const frame = new Uint8Array(5)
    frame[0] = 0x00
    new DataView(frame.buffer).setUint32(1, 17 * 1024 * 1024, false)

    expect(collectFrames(buildStream([frame]))).rejects.toThrow(
      /declared frame length .* exceeds limit/,
    )
  })

  test("handles chunked frame delivery", async () => {
    const payload = new TextEncoder().encode("split across chunks")
    const frame = encodeConnectFrame(payload, false)
    const chunk1 = frame.slice(0, 3)
    const chunk2 = frame.slice(3)

    const frames = await collectFrames(buildStream([chunk1, chunk2]))
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0])).toBe("split across chunks")
  })

  test("cancels the reader when the consumer stops early", async () => {
    let cancelled = false
    const frame = encodeConnectFrame(new TextEncoder().encode("first"), false)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame)
      },
      cancel() {
        cancelled = true
      },
    })

    const iterator = decodeConnectFrames(stream)[Symbol.asyncIterator]()
    const result = await iterator.next()
    expect(result.done).toBe(false)
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })
})
