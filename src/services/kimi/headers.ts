import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import type { ProviderConnection } from "~/lib/provider-connections"

import { getCredentialContextString } from "~/lib/provider-connections"
import { uuidv5 } from "~/lib/uuid"

// UUID v5 namespace (RFC 4122 OID namespace) for deterministic Kimi device ids.
const KIMI_DEVICE_NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

/** Deterministic UUID v5 from a name. Same input → same UUID, stable across restarts. */
function deterministicKimiDeviceId(name: string): string {
  return uuidv5(name, KIMI_DEVICE_NS)
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
