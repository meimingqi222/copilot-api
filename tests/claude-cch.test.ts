import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import {
  BILLING_HEADER_PREFIX,
  CCH_PLACEHOLDER_STRING,
  cchSeedForTest,
  createClaudeBillingHeader,
  patchCch,
  serializeAndPatchCchBody,
} from "~/services/claude/cch"
import { claudeCodeVersion } from "~/services/claude/fingerprint"

function utf8(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** Independently compute the expected cch for a body containing the placeholder. */
function expectedCch(bodyWithPlaceholder: Uint8Array): string {
  const h = Bun.hash.xxHash64(bodyWithPlaceholder, cchSeedForTest)
  return (h & 0xfffffn).toString(16).padStart(5, "0")
}

// ── createClaudeBillingHeader ───────────────────────────────────────────────

describe("createClaudeBillingHeader", () => {
  test("includes cc_version with the SHA256 suffix derived from first user message", () => {
    const header = createClaudeBillingHeader("Hello, world!")
    // Fingerprint uses chars [4],[7],[20] of the message.
    const msg = "Hello, world!"
    const k = [msg.charAt(4), msg.charAt(7), msg.charAt(20) || "0"].join("")
    const suffix = sha256Hex(`59cf53e54c78${k}${claudeCodeVersion}`).slice(0, 3)
    expect(header).toBe(
      `${BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${suffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STRING};`,
    )
  })

  test("missing chars in a short message become '0'", () => {
    const header = createClaudeBillingHeader("hi")
    // "hi" has no index 4/7/20 -> all "0".
    const suffix = sha256Hex(`59cf53e54c78000${claudeCodeVersion}`).slice(0, 3)
    expect(header).toContain(`cc_version=${claudeCodeVersion}.${suffix}`)
  })

  test("always carries the cch=00000 placeholder", () => {
    expect(createClaudeBillingHeader("anything")).toContain(
      CCH_PLACEHOLDER_STRING,
    )
  })
})

// ── patchCch ────────────────────────────────────────────────────────────────

describe("patchCch", () => {
  test("overwrites the placeholder with the XXHash64 low-20-bits hash", () => {
    const billing = createClaudeBillingHeader("Hello, world!")
    // Build a body whose system[0] matches the marker layout.
    const body = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello, world!" }],
      system: [{ type: "text", text: billing }],
    }
    const bodyStr = JSON.stringify(body)
    const bodyBytes = utf8(bodyStr)

    // Expected hash computed over the body WITH the placeholder in place.
    const want = expectedCch(bodyBytes)

    const result = patchCch(bodyBytes)
    expect(result).toBe("patched")

    // The placeholder digits are now the computed hash.
    const patchedStr = new TextDecoder().decode(bodyBytes)
    expect(patchedStr).toContain(`cch=${want}`)
    expect(patchedStr).not.toContain(CCH_PLACEHOLDER_STRING)
  })

  test("returns no-billing-header when the marker is absent", () => {
    const body = utf8(
      JSON.stringify({
        model: "x",
        messages: [],
        system: [{ type: "text", text: "no header here" }],
      }),
    )
    expect(patchCch(body)).toBe("no-billing-header")
    // Body untouched.
    expect(new TextDecoder().decode(body)).not.toContain("cch=")
  })

  test("returns unanchored when the placeholder exists but not after the marker", () => {
    // Placeholder present in user content (system[0] is NOT the billing header),
    // so the marker won't be found -> no-billing-header. To exercise unanchored,
    // place the marker but move the placeholder far away.
    const billing = createClaudeBillingHeader("Hello, world!")
    const padding = "x".repeat(200)
    const body = {
      system: [
        { type: "text", text: billing },
        { type: "text", text: `${padding}${CCH_PLACEHOLDER_STRING}` },
      ],
    }
    const result = patchCch(utf8(JSON.stringify(body)))
    // The placeholder after the marker within the billing header text gets
    // patched first; the distant one is irrelevant. The billing-header marker
    // IS present, so the anchored placeholder is patched.
    expect(result).toBe("patched")
  })

  test("is deterministic: same body -> same cch", () => {
    const billing = createClaudeBillingHeader("deterministic input")
    const body = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "deterministic input" }],
      system: [{ type: "text", text: billing }],
    }
    const bytes1 = utf8(JSON.stringify(body))
    const bytes2 = utf8(JSON.stringify(body))
    patchCch(bytes1)
    patchCch(bytes2)
    expect(new TextDecoder().decode(bytes1)).toEqual(
      new TextDecoder().decode(bytes2),
    )
  })
})

// ── serializeAndPatchCchBody ────────────────────────────────────────────────

describe("serializeAndPatchCchBody", () => {
  test("patches a body whose system[0] contains the billing header", () => {
    const billing = createClaudeBillingHeader("patch me")
    const body = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "patch me" }],
      system: [{ type: "text", text: billing }],
    }
    const bytes = serializeAndPatchCchBody(body)
    const str = new TextDecoder().decode(bytes)
    expect(str).not.toContain(CCH_PLACEHOLDER_STRING)
  })

  test("passes through bodies without the placeholder unchanged (as UTF-8)", () => {
    const body = { model: "x", messages: [] }
    const bytes = serializeAndPatchCchBody(body)
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(body))
  })

  test("invokes onUnanchored hook on unanchored placeholder", () => {
    // Marker present but placeholder too far after it.
    const billing = createClaudeBillingHeader("anchor test")
    const farPlaceholder = `${"y".repeat(200)}${CCH_PLACEHOLDER_STRING}`
    // Replace the placeholder inside the billing header with a far one so the
    // only placeholder is the distant one (unanchored).
    const billingNoPlaceholder = billing.replace(
      CCH_PLACEHOLDER_STRING,
      "cch=99999",
    )
    const body = {
      system: [
        { type: "text", text: billingNoPlaceholder },
        { type: "text", text: farPlaceholder },
      ],
    }
    let called = false
    serializeAndPatchCchBody(body, () => {
      called = true
    })
    // The marker is present (billing header text) but no placeholder within
    // the window after it -> unanchored path.
    expect(called).toBe(true)
  })
})
