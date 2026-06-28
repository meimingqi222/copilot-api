import { ProtobufEncoder } from "./protobuf"

export interface WindsurfClientSettings {
  clientName: string
  appVersion: string
  lsVersion: string
  /** Metadata field 12 — extension_name (Devin CLI: "chisel", Windsurf IDE: "windsurf"). */
  extensionName?: string
  /** Metadata field 28 — ide_type. */
  ideType?: string
}

export interface WindsurfMetadataOptions {
  apiKey: string
  settings: WindsurfClientSettings
  /** Stable per-conversation session (metadata field 10). */
  sessionId?: string
  /** Short-lived JWT from GetUserJwt (metadata field 21). */
  userJwt?: string
  /** Monotonic request id (metadata field 9). */
  requestId?: number
  /** Per-RPC trigger id (metadata field 25). */
  triggerId?: string
  /** Workspace/repo fingerprint (metadata field 31) — stable per conversation. */
  workspaceFingerprint?: string
}

// Real GetChatMessage capture sends just the OS label (e.g. "windows") in
// field[5], not a JSON system-info blob. Verified from live traffic.
function getOsLabel(): string {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  return process.platform
}

function buildTimestampMessage(): ProtobufEncoder {
  const now = Date.now()
  const seconds = Math.floor(now / 1000)
  const nanos = (now % 1000) * 1_000_000
  const ts = new ProtobufEncoder()
  ts.writeVarint(1, seconds)
  if (nanos > 0) ts.writeVarint(2, nanos)
  return ts
}

export function buildWindsurfClientMetadata(
  opts: WindsurfMetadataOptions,
): ProtobufEncoder {
  const extensionName = opts.settings.extensionName ?? "chisel"
  const ideType = opts.settings.ideType ?? "windsurf"
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, opts.settings.clientName)
  metadata.writeString(2, opts.settings.appVersion)
  metadata.writeString(3, opts.apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(5, getOsLabel())
  metadata.writeString(7, opts.settings.lsVersion)
  if (opts.requestId !== undefined) {
    metadata.writeVarint(9, opts.requestId)
  }
  if (opts.sessionId) {
    metadata.writeString(10, opts.sessionId)
  }
  metadata.writeString(12, extensionName)
  metadata.writeMessage(16, buildTimestampMessage())
  if (opts.triggerId) {
    metadata.writeString(25, opts.triggerId)
  }
  metadata.writeString(26, "Unset")
  metadata.writeString(28, ideType)
  if (opts.workspaceFingerprint) {
    metadata.writeString(31, opts.workspaceFingerprint)
  }
  if (opts.userJwt) {
    metadata.writeString(21, opts.userJwt)
  }
  return metadata
}

export function wrapWindsurfMetadataMessage(
  metadata: ProtobufEncoder,
): Uint8Array {
  const outer = new ProtobufEncoder()
  outer.writeMessage(1, metadata)
  return outer.toUint8Array()
}
