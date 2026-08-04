import { describe, expect, test } from "bun:test"

import {
  decodeWsFrame,
  encodeWsFrame,
  MAX_MIMO_RESPONSE_BYTES,
} from "~/services/mimo/ws-proxy"

describe("Mimo WebSocket frame limits", () => {
  test("decodes valid frames", () => {
    const frame = decodeWsFrame(encodeWsFrame(Buffer.from("hello")))

    expect(frame.opcode).toBe(1)
    expect(frame.payload.toString()).toBe("hello")
    expect(frame.remaining.length).toBe(0)
  })

  test("rejects incomplete frame headers and payloads", () => {
    expect(() => decodeWsFrame(Buffer.from([0x81]))).toThrow(
      "Incomplete WebSocket frame header",
    )
    expect(() => decodeWsFrame(Buffer.from([0x81, 126, 0]))).toThrow(
      "Incomplete WebSocket extended frame length",
    )
    expect(() => decodeWsFrame(Buffer.from([0x81, 1]))).toThrow(
      "Incomplete WebSocket frame payload",
    )
  })

  test("rejects oversized 64-bit lengths before allocation", () => {
    const frame = Buffer.alloc(10)
    frame[0] = 0x81
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(MAX_MIMO_RESPONSE_BYTES + 1), 2)

    expect(() => decodeWsFrame(frame)).toThrow(
      "WebSocket frame exceeds the maximum size",
    )
  })
})
