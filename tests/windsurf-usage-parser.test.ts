import { describe, expect, test } from "bun:test"
import fs from "node:fs"

import { mergeWindsurfUsageFrames } from "~/services/windsurf/create-chat-completions"
import { parseMessage } from "~/services/windsurf/protobuf"
import {
  extractRawUsageSignals,
  parseChatStreamFrame,
} from "~/services/windsurf/response-parsers"

// UsageMetadata (field 7) aligns with field[28] Token Usage in live captures:
//   field[2] = input_tokens  (prompt)
//   field[3] = output_tokens (completion)
//   field[1] = auxiliary (ignored for totals)
// Cache comes from field[33] and field[28] cached_input_tokens — not field[7] #3.

// ── Protobuf helpers (minimal encoder) ─────────────────────────────────────

function encodeVarint(input: number): Buffer {
  const b: Array<number> = []
  let remaining = input
  while (true) {
    const byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) b.push(byte | 0x80)
    else {
      b.push(byte)
      break
    }
  }
  return Buffer.from(b)
}

function encodeTag(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire)
}

function encodeVarintField(field: number, v: number): Buffer {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(v)])
}

function encodeLengthDelimited(field: number, data: Buffer): Buffer {
  return Buffer.concat([encodeTag(field, 2), encodeVarint(data.length), data])
}

function buildUsageMetadata(): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 347),
    encodeVarintField(2, 3223),
    encodeVarintField(3, 122),
    encodeVarintField(6, 4),
    encodeLengthDelimited(7, Buffer.from("msg_01XQT3XhcxVkvWxgtvF47jY9")),
    encodeLengthDelimited(9, Buffer.from("MODEL_PRIVATE_11")),
  ])
}

function buildFramePayload(): Uint8Array {
  const usageMetadata = buildUsageMetadata()
  return new Uint8Array(
    Buffer.concat([
      encodeLengthDelimited(1, Buffer.from("request-uuid")),
      encodeLengthDelimited(2, Buffer.from("session-uuid")),
      encodeVarintField(5, 10),
      encodeLengthDelimited(7, usageMetadata),
    ]),
  )
}

describe("parseChatStreamFrame - UsageMetadata field mapping", () => {
  test("parses reasoning_text field[9] alongside content deltas", () => {
    const frame = new Uint8Array(
      Buffer.concat([
        encodeLengthDelimited(3, Buffer.from("visible")),
        encodeLengthDelimited(9, Buffer.from("thinking")),
        encodeLengthDelimited(10, Buffer.from("signature")),
      ]),
    )

    expect(parseChatStreamFrame(frame).deltas).toEqual([
      { kind: "content", text: "visible" },
      { kind: "reasoning_text", text: "thinking" },
      { kind: "reasoning_signature", text: "signature" },
    ])
  })

  test("maps max-token stop reason from field[5]", () => {
    const frame = new Uint8Array(encodeVarintField(5, 3))
    expect(parseChatStreamFrame(frame).finishReason).toBe("length")
  })

  test("maps field[2]/[3] to prompt/completion (not field[3] as cache)", () => {
    const parsed = parseChatStreamFrame(buildFramePayload())
    const usage = parsed.usage

    expect(parsed.textDone).toBe(false)
    expect(parsed.toolCallsDone).toBe(true)
    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
    expect(usage?.total_tokens).toBe(3345)
    expect(usage?.cached_tokens).toBe(0)
    expect(usage?.cache_read_tokens).toBeUndefined()
  })

  test("regression: protobuf structure matches live capture", () => {
    const decoded = parseMessage(buildFramePayload(), 0, 3)
    const f7 = decoded.find((n) => n.field === 7 && n.wire === 2)
    const sub = f7?.sub

    expect(f7).toBeDefined()
    expect(sub).toBeDefined()

    const subVarints = (sub ?? [])
      .filter((n) => n.wire === 0 && n.varint !== undefined)
      .map((n) => n.field)
    expect(subVarints).toContain(1)
    expect(subVarints).toContain(2)
    expect(subVarints).toContain(3)
    expect(subVarints).toContain(6)
  })
})

// ── field[28] "Token Usage" section ──────────────────────────────────────────

function encodeFloat32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat32(
    0,
    value,
    true,
  )
  return buf
}

function buildValueBlock(label: string, value: number): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(1, Buffer.from(label)),
    Buffer.concat([encodeTag(2, 5), encodeFloat32(value)]),
    encodeLengthDelimited(3, Buffer.from(" token")),
    encodeLengthDelimited(4, Buffer.from(" tokens")),
  ])
}

function buildTokenSection(name: string, value: number): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(5, Buffer.from(name)),
    encodeLengthDelimited(4, buildValueBlock(name, value)),
  ])
}

function buildTokenUsageField28(): Buffer {
  const titleField = encodeLengthDelimited(1, Buffer.from("Token Usage"))
  const inputSection = encodeLengthDelimited(
    2,
    buildTokenSection("input_tokens", 3223),
  )
  const outputSection = encodeLengthDelimited(
    2,
    buildTokenSection("output_tokens", 122),
  )
  const cachedSection = encodeLengthDelimited(
    2,
    buildTokenSection("cached_input_tokens", 0),
  )
  return encodeLengthDelimited(
    28,
    Buffer.concat([titleField, inputSection, outputSection, cachedSection]),
  )
}

describe("parseChatStreamFrame - field[28] Token Usage", () => {
  test("cross-frame merge preserves completion when field[28] omits it", () => {
    const merged = mergeWindsurfUsageFrames(
      {
        prompt_tokens: 100,
        completion_tokens: 23,
        total_tokens: 123,
        cached_tokens: 0,
      },
      {
        prompt_tokens: 180,
        completion_tokens: 0,
        total_tokens: 180,
        cached_tokens: 80,
        cache_read_tokens: 80,
      },
      {
        field28: { inputTokens: 100, cachedInputTokens: 80 },
      },
    )

    expect(merged).toEqual({
      prompt_tokens: 180,
      completion_tokens: 23,
      total_tokens: 203,
      cached_tokens: 80,
      cache_read_tokens: 80,
    })
  })

  test("cross-frame merge accepts an explicit zero completion field", () => {
    const merged = mergeWindsurfUsageFrames(
      {
        prompt_tokens: 100,
        completion_tokens: 23,
        total_tokens: 123,
        cached_tokens: 0,
      },
      {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
      },
      { field7: { f2: 0, f3: 0 } },
    )

    expect(merged.prompt_tokens).toBe(0)
    expect(merged.completion_tokens).toBe(0)
    expect(merged.total_tokens).toBe(0)
  })

  test("parses input_tokens / output_tokens / cached_input_tokens from field[28]", () => {
    const frame = new Uint8Array(buildTokenUsageField28())
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
    expect(usage?.total_tokens).toBe(3345)
    expect(usage?.cached_tokens).toBe(0)
    expect(usage?.cache_read_tokens).toBe(0)
  })

  test("field[28] takes precedence over field[7] when both are present", () => {
    const field28 = buildTokenUsageField28()
    const field7Partial = Buffer.concat([
      encodeVarintField(1, 347),
      encodeVarintField(2, 9999),
      encodeVarintField(3, 8888),
    ])
    const field7 = encodeLengthDelimited(7, field7Partial)
    const frame = new Uint8Array(Buffer.concat([field7, field28]))
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
  })

  test("field[28] prompt_tokens includes cached_input_tokens (OpenAI semantic)", () => {
    const titleField = encodeLengthDelimited(1, Buffer.from("Token Usage"))
    const inputSection = encodeLengthDelimited(
      2,
      buildTokenSection("input_tokens", 2973),
    )
    const outputSection = encodeLengthDelimited(
      2,
      buildTokenSection("output_tokens", 3516),
    )
    const cachedSection = encodeLengthDelimited(
      2,
      buildTokenSection("cached_input_tokens", 136991),
    )
    const field28 = encodeLengthDelimited(
      28,
      Buffer.concat([titleField, inputSection, outputSection, cachedSection]),
    )
    const frame = new Uint8Array(field28)
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(139964)
    expect(usage?.completion_tokens).toBe(3516)
    expect(usage?.total_tokens).toBe(143480)
    expect(usage?.cached_tokens).toBe(136991)
    expect(usage?.cache_read_tokens).toBe(136991)
  })

  test("field[28] cached=0 does not wipe field[33] cache (Math.max merge)", () => {
    const field7 = encodeLengthDelimited(7, buildUsageMetadata())
    const field28 = buildTokenUsageField28()
    const frame = new Uint8Array(
      Buffer.concat([encodeVarintField(33, 50654), field7, field28]),
    )
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
    expect(usage?.cached_tokens).toBe(50654)
    expect(usage?.cache_read_tokens).toBe(50654)
  })

  test("field[33] provides authoritative cache_read_tokens", () => {
    const frame = new Uint8Array(
      Buffer.concat([
        encodeVarintField(33, 50654),
        encodeLengthDelimited(7, buildUsageMetadata()),
      ]),
    )
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
    expect(usage?.cached_tokens).toBe(50654)
    expect(usage?.cache_read_tokens).toBe(50654)
  })
})

describe("parseChatStreamFrame - live capture regression", () => {
  test("extractRawUsageSignals reads field[7]/[28]/[33] separately", () => {
    const frame = new Uint8Array(
      Buffer.concat([
        encodeVarintField(33, 50654),
        encodeLengthDelimited(7, buildUsageMetadata()),
        buildTokenUsageField28(),
      ]),
    )
    const raw = extractRawUsageSignals(frame)
    expect(raw).toBeDefined()
    expect(raw?.field7?.f2).toBe(3223)
    expect(raw?.field7?.f3).toBe(122)
    expect(raw?.field33).toBe(50654)
    expect(raw?.field28?.inputTokens).toBe(3223)
    expect(raw?.field28?.outputTokens).toBe(122)
    expect(raw?.field28?.cachedInputTokens).toBe(0)
  })

  test("GetChatMessage-res frame 11+12 match field[28] metrics", () => {
    const capturePath = "D:/code/copilot-refs/data/GetChatMessage-res"
    if (!fs.existsSync(capturePath)) return

    const buf = fs.readFileSync(capturePath)
    let offset = 0
    const frames: Array<Uint8Array> = []
    while (offset + 5 <= buf.length) {
      const flags = buf[offset]
      const length = buf.readUInt32BE(offset + 1)
      offset += 5
      let payload = buf.subarray(offset, offset + length)
      offset += length
      if (flags === 1 || flags === 3) {
        payload = Buffer.from(Bun.gunzipSync(payload))
      }
      frames.push(new Uint8Array(payload))
    }

    const frame11 = frames[10]
    const frame12 = frames[11]
    expect(frame11).toBeDefined()
    expect(frame12).toBeDefined()

    const parsed11 = parseChatStreamFrame(frame11)
    const parsed12 = parseChatStreamFrame(frame12)

    expect(parsed11.usage?.prompt_tokens).toBe(3223)
    expect(parsed11.usage?.completion_tokens).toBe(122)
    expect(parsed11.usage?.cached_tokens).toBe(0)

    expect(parsed12.usage?.prompt_tokens).toBe(3223)
    expect(parsed12.usage?.completion_tokens).toBe(122)
    expect(parsed12.usage?.cached_tokens).toBe(0)
  })
})
