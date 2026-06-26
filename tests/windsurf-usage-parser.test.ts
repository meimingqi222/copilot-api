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

// ── field[28] "Token Usage" section ──────────────────────────────────────────
//
// Captured responses (e.g. D:\code\copilot-refs\data\GetChatMessage-res) carry
// the authoritative usage numbers in a field[28] sub-message titled "Token Usage".
// Inside it are three named sections (field[2] with field[5]=name, field[4]
// containing a float32 value in sub-field[2] wire=5):
//   - "input_tokens"         → real prompt size
//   - "output_tokens"        → real completion size
//   - "cached_input_tokens"  → KV cache hits
// For models that report usage only via field[28] (no usable field[7]), the
// parser MUST extract all three — otherwise prompt_tokens stays 0 and the
// dashboard shows nonsense like "input=0, cacheHitRate=100%".

function encodeFloat32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat32(
    0,
    value,
    true,
  )
  return buf
}

// Build a field[4] value block: { field[1]: "label", field[2] float32: value, field[3]: " unit", field[4]: " units" }
function buildValueBlock(label: string, value: number): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(1, Buffer.from(label)),
    Buffer.concat([encodeTag(2, 5), encodeFloat32(value)]),
    encodeLengthDelimited(3, Buffer.from(" token")),
    encodeLengthDelimited(4, Buffer.from(" tokens")),
  ])
}

// Build one field[2] section inside Token Usage: { field[5]=name, field[4]=valueBlock }
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
    // Simulate the GLM-5-2 scenario: field[7] reports prompt_tokens=0 (because
    // the upstream didn't fill it), and field[28] carries the real numbers.
    const field28 = buildTokenUsageField28()
    // Override field[7] usage to simulate the bug: prompt=0, completion=131560
    const buggyMetadata = Buffer.concat([
      encodeVarintField(1, 0), // prompt_tokens = 0 (bug)
      encodeVarintField(2, 131560), // completion_tokens
      encodeVarintField(3, 2997), // cached_tokens
    ])
    const field7Buggy = encodeLengthDelimited(7, buggyMetadata)
    const frame = new Uint8Array(Buffer.concat([field7Buggy, field28]))
    const parsed = parseChatStreamFrame(frame)
    const usage = parsed.usage

    expect(usage).toBeDefined()
    // field[28] should override the buggy field[7] prompt_tokens=0
    // prompt_tokens = input(3223) + cached(0) = 3223 (OpenAI semantic, includes cache)
    expect(usage?.prompt_tokens).toBe(3223)
    expect(usage?.completion_tokens).toBe(122)
  })

  test("field[28] prompt_tokens includes cached_input_tokens (OpenAI semantic)", () => {
    // Windsurf input_tokens EXCLUDES cache, but OpenAI prompt_tokens INCLUDES cache.
    // mergeField28Usage must convert: prompt_tokens = input + cached.
    // This ensures total_tokens includes cache and handler.ts prompt-cached
    // subtraction yields the correct non-cached input.
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
    // prompt_tokens = input(2973) + cached(136991) = 139964 (OpenAI semantic)
    expect(usage?.prompt_tokens).toBe(139964)
    expect(usage?.completion_tokens).toBe(3516)
    // total = prompt(139964) + completion(3516) = 143480 (includes cache)
    expect(usage?.total_tokens).toBe(143480)
    expect(usage?.cached_tokens).toBe(136991)
    expect(usage?.cache_read_tokens).toBe(136991)
  })
})
