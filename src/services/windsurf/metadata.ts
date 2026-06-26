import { ProtobufEncoder } from "./protobuf"

export interface WindsurfClientSettings {
  clientName: string
  appVersion: string
  lsVersion: string
}

// Real GetChatMessage capture sends just the OS label (e.g. "windows") in
// field[5], not a JSON system-info blob. Verified from live traffic.
function getOsLabel(): string {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  return process.platform
}

export function buildWindsurfClientMetadata(opts: {
  apiKey: string
  settings: WindsurfClientSettings
}): ProtobufEncoder {
  // Field layout verified from live GetChatMessage capture (Devin/chisel client):
  //   field[1]  = client_name    ("windsurf-next")
  //   field[2]  = app_version    ("2026.8.1009")
  //   field[3]  = api_key / devin-session-token$<jwt>
  //   field[4]  = language       ("en")
  //   field[5]  = os label       ("windows" — NOT a JSON blob)
  //   field[7]  = ls_version
  //   field[12] = client_name (duplicate)
  //
  // Fields NOT sent (matching Devin capture):
  //   field[8]  = hardware_json  — removed
  //   field[21] = jwt            — removed (credential goes in field[3])
  //   field[30] = platform_id    — removed
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, opts.settings.clientName)
  metadata.writeString(2, opts.settings.appVersion)
  metadata.writeString(3, opts.apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(5, getOsLabel())
  metadata.writeString(7, opts.settings.lsVersion)
  metadata.writeString(12, opts.settings.clientName)
  return metadata
}

export function wrapWindsurfMetadataMessage(
  metadata: ProtobufEncoder,
): Uint8Array {
  const outer = new ProtobufEncoder()
  outer.writeMessage(1, metadata)
  return outer.toUint8Array()
}
