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

// Devin CLI metadata layout (verified from live GetChatMessage capture):
//   f1=clientName  f2=appVersion  f3=apiKey  f4="en"  f5=OS label
//   f7=lsVersion   f12=extensionName  f28=ideType  f31=workspaceFingerprint
// Deliberately omits f9(requestId), f10(sessionId), f16(timestamp),
// f21(userJwt), f25(triggerId), f26 — the Windsurf IDE client sends those,
// but the Devin CLI does not, and the extra fields create an anomalous
// fingerprint that can trigger per-model rate limits.
export function buildWindsurfClientMetadata(
  opts: WindsurfMetadataOptions,
): ProtobufEncoder {
  const extensionName = opts.settings.extensionName ?? "chisel"
  const ideType = opts.settings.ideType ?? "chisel"
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, opts.settings.clientName)
  metadata.writeString(2, opts.settings.appVersion)
  metadata.writeString(3, opts.apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(5, getOsLabel())
  metadata.writeString(7, opts.settings.lsVersion)
  metadata.writeString(12, extensionName)
  metadata.writeString(28, ideType)
  if (opts.workspaceFingerprint) {
    metadata.writeString(31, opts.workspaceFingerprint)
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
