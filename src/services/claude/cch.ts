/**
 * Claude Code billing-header `cch` attestation.
 *
 * Real Claude Code injects an `x-anthropic-billing-header` into `system[0]`
 * carrying a `cch=` attestation hash computed over the request body. Without a
 * valid `cch`, Anthropic's backend can detect non-CC clients. This module
 * reproduces the exact algorithm reverse-engineered from CC so OAuth traffic
 * through copilot-api is indistinguishable from the official CLI.
 *
 * Two-stage process (matches CC's in-place behaviour):
 * 1. `createClaudeBillingHeader` builds the header text with a `cch=00000`
 *    placeholder and injects it into `system[0]` BEFORE serialization.
 * 2. After `JSON.stringify`, `patchCch` locates the placeholder inside the
 *    serialized body bytes and overwrites it with the real hash. The hash is
 *    computed over the body WITH the placeholder in place (not patched) -
 *    this matches CC, which leaves the placeholder bytes in memory while
 *    hashing then overwrites them.
 *
 * Ported from oh-my-pi packages/ai/src/providers/anthropic.ts (567-645).
 */

import { createHash } from "node:crypto"

import { claudeCodeVersion } from "./fingerprint"

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:"

// cch attestation: XXHash64(body_with_placeholder, seed) low-20-bits, 5 hex chars.
const CCH_SEED = 0x4d659218e32a3268n
const CCH_PLACEHOLDER_STR = "cch=00000"
const cchEncoder = new TextEncoder()
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR)

// Combined anchor for the billing-header placeholder inside system[0].
// `"system":[{"type":"text","text":"x-anthropic-billing-header:`
// Matches the exact JSON prefix of the first system block when
// `createClaudeBillingHeader` injects system[0]. `messages` serializes before
// `system` in JSON.stringify output of our ordered payload, so user content in
// the messages array can never match this sequence. User system prompt text
// lives in system[2+] and therefore also cannot match.
const BILLING_SYSTEM_MARKER = cchEncoder.encode(
  `"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`,
)
const CCH_BILLING_SEARCH_WINDOW = 150

export type CchPatchResult = "patched" | "no-billing-header" | "unanchored"

/**
 * Builds the `x-anthropic-billing-header` text with a `cch=00000` placeholder.
 *
 * Fingerprint: `SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]`
 * Matches CC's `computeFingerprint` in utils/fingerprint.ts. Uses chars from
 * the first user message (not the system prompt); missing chars become "0".
 *
 * The placeholder is replaced with the real attestation hash by `patchCch`
 * after the body is serialized.
 */
export function createClaudeBillingHeader(
  firstUserMessageText: string,
): string {
  const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? "0").join("")
  const versionSuffix = createHash("sha256")
    .update(`59cf53e54c78${k}${claudeCodeVersion}`)
    .digest("hex")
    .slice(0, 3)
  return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STR};`
}

/** The placeholder string, exposed so callers can sanity-check body content. */
export const CCH_PLACEHOLDER_STRING = CCH_PLACEHOLDER_STR

/** Marker prefix that `patchCch` anchors on (exposed for tests). */
export const BILLING_HEADER_PREFIX = CLAUDE_BILLING_HEADER_PREFIX

/**
 * Patches the `cch` attestation into a serialized request body (in place).
 *
 * The body MUST be the UTF-8 bytes of a JSON payload whose `system[0].text`
 * contains a `createClaudeBillingHeader` value (and thus the placeholder).
 *
 * - Finds the `"system":[{"type":"text","text":"x-anthropic-billing-header:`
 *   marker, then the `cch=00000` placeholder within 150 bytes after it.
 * - Computes `XXHash64(body, CCH_SEED) & 0xfffff` (5 hex chars) and overwrites
 *   the placeholder digits in place.
 *
 * Returns:
 * - `"patched"`: placeholder found and overwritten.
 * - `"no-billing-header"`: no billing-header marker present (body untouched).
 * - `"unanchored"`: placeholder present but not anchored to system[0] - a
 *   fingerprint regression; the body is left with `cch=00000`.
 */
export function patchCch(body: Uint8Array): CchPatchResult {
  // Zero-copy Buffer view over the same memory; Buffer.indexOf is a native
  // memmem scan - far faster than a hand-rolled byte loop, and the marker sits
  // near the end of the body because `messages` serializes before `system`.
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength)

  const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER)
  if (markerIdx === -1) return "no-billing-header"

  const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
  const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom)
  if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) {
    return "unanchored"
  }

  // Hash the body with the placeholder in place (matches CC's in-place behaviour).
  const h = Bun.hash.xxHash64(body, CCH_SEED)
  const cch = (h & 0xfffffn).toString(16).padStart(5, "0")

  for (let i = 0; i < 5; i++) {
    const cp = cch.codePointAt(i)
    if (cp === undefined) break
    body[idx + 4 + i] = cp
  }
  return "patched"
}

/**
 * Serializes + patches a request body in one step. Returns the patched bytes
 * (a `Uint8Array` suitable for use as a fetch `body`).
 *
 * If the body does not contain the billing-header placeholder it is returned
 * unchanged (UTF-8 encoded). An `unanchored` result (placeholder present but
 * not anchored to system[0]) is logged via the optional `onUnanchored` hook
 * rather than failing the request - matching CC's prior behaviour of shipping
 * `cch=00000` when the fingerprint can't be computed.
 */
export function serializeAndPatchCchBody(
  body: unknown,
  onUnanchored?: () => void,
): Uint8Array {
  const str = JSON.stringify(body)
  const encoded = cchEncoder.encode(str)
  const result = patchCch(encoded)
  if (result === "unanchored") {
    onUnanchored?.()
  }
  return encoded
}

// Re-export for tests that need to compute the expected hash independently.
export { CCH_SEED as cchSeedForTest }

export { randomUUID } from "node:crypto"
