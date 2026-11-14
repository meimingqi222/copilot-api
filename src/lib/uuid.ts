/**
 * Deterministic UUID v5 (SHA-1 based, RFC 4122).
 *
 * Shared by the callers that need stable, name-derived identifiers (Codex
 * identity confusion, Kimi device ids, Windsurf session ids). The namespace
 * is a parameter on purpose: each caller pins its own namespace bytes, and
 * the resulting UUIDs are used as cache keys / device identities, so they must
 * never drift. Same (namespace, name) always yields the same UUID.
 */

import { createHash } from "node:crypto"

/**
 * @param name the name to hash.
 * @param namespace the UUID v5 namespace, as hex (dashes optional) or bytes.
 */
export function uuidv5(name: string, namespace: string | Buffer): string {
  const ns =
    typeof namespace === "string" ?
      Buffer.from(namespace.replaceAll("-", ""), "hex")
    : namespace
  const bytes = createHash("sha1")
    .update(ns)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16)
  // Set version (5) and variant bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
