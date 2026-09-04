import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"

import type { ProviderConnection } from "~/lib/provider-connections"

import { getCredentialContextString } from "~/lib/provider-connections"

// UUID v5 namespace (RFC 4122 OID namespace) for deterministic Kimi device ids.
const KIMI_DEVICE_NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

/** Deterministic UUID v5 from a name. Same input → same UUID, stable across restarts. */
function deterministicKimiDeviceId(name: string): string {
  const hash = createHash("sha1")
  hash.update(Buffer.from(KIMI_DEVICE_NS.replaceAll("-", ""), "hex"))
  hash.update(name, "utf8")
  const digest = hash.digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

/**
 * Resolve a stable per-connection device ID. OAuth connections keep the device
 * ID issued at login (credential.context.deviceId). The per-request
 * randomUUID() fallback is avoided because a fresh device ID on every request
 * reads as an unstable/bot device, which is the signal Kimi's anti-abuse
 * looks for.
 */
function resolveKimiDeviceId(connection: ProviderConnection): string {
  const id = connection.id.trim()
  if (!id) return randomUUID()
  return (
    getCredentialContextString(connection, "deviceId")
    ?? deterministicKimiDeviceId(`kimi:${id}`)
  )
}

export function buildKimiHeaders(
  connection: ProviderConnection,
  accessToken: string,
  stream?: boolean,
): Record<string, string> {
  const deviceId = resolveKimiDeviceId(connection)

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "KimiCLI/1.10.6",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.10.6",
    "X-Msh-Device-Name": hostname() || "unknown",
    "X-Msh-Device-Model": `${process.platform} ${process.arch}`,
    "X-Msh-Device-Id": deviceId,
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
