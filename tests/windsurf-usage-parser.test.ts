import { describe, expect, test } from "bun:test"

import { parseMessage } from "~/services/windsurf/protobuf"
import { parseChatStreamFrame } from "~/services/windsurf/response-parsers"

// Regression test for the UsageMetadata field-mapping bug.
//
// Captured GetChatMessage responses show UsageMetadata (field 7) sub-fields are:
//   field[1] = prompt_tokens
//   field[2] = completion_tokens
//   field[3] = cached_tokens (KV cache hits)
// Previously the parser used field[2]/[3]/[4]/[5], which produced totally
// wrong token counts (prompt and completion swapped, cache reads dropped).

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

// Build a UsageMetadata sub-message with the same field layout as the
// real GetChatMessage final frame: field[1]=prompt, field[2]=completion,
// field[3]=cached, plus a few unrelated fields we want to ensure are ignored.
function buildUsageMetadata(): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 347), // prompt_tokens
    encodeVarintField(2, 3223), // completion_tokens
    encodeVarintField(3, 122), // cached_tokens
    encodeVarintField(6, 4), // unknown flag (must not be misread as a token count)
    encodeLengthDelimited(7, Buffer.from("msg_01XQT3XhcxVkvWxgtvF47jY9")),
    encodeLengthDelimited(9, Buffer.from("MODEL_PRIVATE_11")),
  ])
}

// Build a single RawChatMessage frame payload (already stripped of the
// 5-byte Connect header — that's what parseChatStreamFrame expects).
function buildFramePayload(): Uint8Array {
  const usageMetadata = buildUsageMetadata()
  return new Uint8Array(
    Buffer.concat([
      encodeLengthDelimited(1, Buffer.from("request-uuid")), // f1
      encodeLengthDelimited(2, Buffer.from("session-uuid")), // f2
      encodeVarintField(5, 10), // stop signal: tool_calls done
      encodeLengthDelimited(7, usageMetadata), // UsageMetadata
    ]),
  )
}

describe("parseChatStreamFrame - UsageMetadata field mapping", () => {
  test("maps field[1]/[2]/[3] to prompt/completion/cached tokens", () => {
    const parsed = parseChatStreamFrame(buildFramePayload())
    const usage = parsed.usage

    expect(parsed.textDone).toBe(false)
    expect(parsed.toolCallsDone).toBe(true)
    expect(usage).toBeDefined()
    expect(usage?.prompt_tokens).toBe(347)
    expect(usage?.completion_tokens).toBe(3223)
    expect(usage?.total_tokens).toBe(3570)
    expect(usage?.cached_tokens).toBe(122)
    expect(usage?.cache_read_tokens).toBe(122)
  })

  test("regression: protobuf structure matches live capture", () => {
    // Sanity-check that the test fixture parses to the same sub-field layout
    // we observed in D:\code\copilot-refs\data\GetChatMessage-res frame 10.
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
