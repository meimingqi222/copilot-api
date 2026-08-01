import { describe, expect, test } from "bun:test"

import {
  buildWindsurfClientMetadata,
  normalizeDevinApiKey,
} from "~/services/windsurf/metadata"
import { ProtobufEncoder, parseMessage } from "~/services/windsurf/protobuf"

// ── normalizeDevinApiKey ────────────────────────────────────────────────────

describe("normalizeDevinApiKey", () => {
  test("prefixes a bare token with the session-token prefix", () => {
    expect(normalizeDevinApiKey("abc123")).toBe("devin-session-token$abc123")
  })

  test("leaves an already-prefixed token unchanged", () => {
    expect(normalizeDevinApiKey("devin-session-token$abc123")).toBe(
      "devin-session-token$abc123",
    )
  })
})

// ── buildWindsurfClientMetadata ─────────────────────────────────────────────

function metadataFields(
  metadata: ProtobufEncoder,
): Array<{ field: number; text: string }> {
  const nodes = parseMessage(metadata.toUint8Array())
  const decoder = new TextDecoder()
  return nodes
    .filter((n) => n.raw)
    .map((n) => ({ field: n.field, text: decoder.decode(n.raw) }))
}

describe("buildWindsurfClientMetadata", () => {
  test("sets the core Windsurf identity fields", () => {
    const fields = metadataFields(buildWindsurfClientMetadata("tok"))
    const byField = new Map(fields.map((f) => [f.field, f.text]))
    expect(byField.get(1)).toBe("windsurf") // ide_name
    expect(byField.get(2)).toBe("1.48.2") // extension_version
    expect(byField.get(3)).toBe("devin-session-token$tok") // api_key
    expect(byField.get(4)).toBe("en") // locale
    expect(byField.get(7)).toBe("3.2.23") // ide_version
    expect(byField.get(12)).toBe("windsurf") // extension_name
  })

  test("omits userJwt (field 21) when not provided", () => {
    const fields = metadataFields(buildWindsurfClientMetadata("tok"))
    expect(fields.find((f) => f.field === 21)).toBeUndefined()
  })

  test("sets userJwt (field 21) when provided", () => {
    const fields = metadataFields(buildWindsurfClientMetadata("tok", "my-jwt"))
    const f21 = fields.find((f) => f.field === 21)
    expect(f21).toBeDefined()
    expect(f21?.text).toBe("my-jwt")
  })

  test("userJwt field sits alongside the core fields (no clobbering)", () => {
    const fields = metadataFields(buildWindsurfClientMetadata("tok", "jwt"))
    const byField = new Map(fields.map((f) => [f.field, f.text]))
    expect(byField.get(3)).toBe("devin-session-token$tok")
    expect(byField.get(21)).toBe("jwt")
  })
})
