import { describe, expect, test } from "bun:test"

import {
  buildWindsurfClientMetadata,
  DEVIN_CLI_IDENTITY,
  normalizeDevinApiKey,
  WINDSURF_EDITOR_IDENTITY,
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
  test("defaults to the released Devin CLI (chisel) identity", () => {
    const fields = metadataFields(buildWindsurfClientMetadata("tok"))
    const byField = new Map(fields.map((f) => [f.field, f.text]))
    expect(byField.get(1)).toBe("devin-cli") // ide_name
    expect(byField.get(2)).toBe("3000.10.21") // extension_version
    expect(byField.get(3)).toBe("devin-session-token$tok") // api_key
    expect(byField.get(4)).toBe("en") // locale
    expect(byField.get(5)).toBe(DEVIN_CLI_IDENTITY.os) // os
    expect(byField.get(7)).toBe("3000.10.21") // ide_version
    expect(byField.get(12)).toBe("chisel") // extension_name
    expect(byField.get(28)).toBe("chisel") // ide_type
  })

  test("os is the normalized platform word, never process.platform raw", () => {
    expect(["darwin", "windows", "linux"]).toContain(
      DEVIN_CLI_IDENTITY.os ?? "",
    )
  })

  test("keeps the legacy editor identity available for catalog fallback", () => {
    const fields = metadataFields(
      buildWindsurfClientMetadata("tok", undefined, WINDSURF_EDITOR_IDENTITY),
    )
    const byField = new Map(fields.map((f) => [f.field, f.text]))
    expect(byField.get(1)).toBe("windsurf") // ide_name
    expect(byField.get(2)).toBe("1.48.2") // extension_version
    expect(byField.get(7)).toBe("3.2.23") // ide_version
    expect(byField.get(12)).toBe("windsurf") // extension_name
    // The editor capture does not declare os/ide_type.
    expect(byField.get(5)).toBeUndefined()
    expect(byField.get(28)).toBeUndefined()
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
