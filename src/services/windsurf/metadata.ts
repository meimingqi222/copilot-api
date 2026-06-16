import os from "node:os"

import { ProtobufEncoder } from "./protobuf"

export interface WindsurfClientSettings {
  clientName: string
  appVersion: string
  lsVersion: string
}

const _arch = os.arch() === "x64" ? "amd64" : os.arch()
const _cpus = os.cpus()
const _cpuModel = _cpus[0]?.model ?? "Unknown CPU"
const _numCores = _cpus.length
const _totalMemMB = Math.round(os.totalmem() / (1024 * 1024))
const _release = os.release()
const _releaseParts = _release.split(".")
const _build = _releaseParts[2] ?? ""
const _major = Number.parseInt(_releaseParts[0] ?? "10")
const _minor = Number.parseInt(_releaseParts[1] ?? "0")

function getProductName(): string {
  if (process.platform === "darwin") return "macOS"
  if (process.platform === "linux") return "Linux"
  return (Number.parseInt(_build) || 0) >= 22000 ?
      "Windows 11 Pro"
    : "Windows 10 Pro"
}

function getOsLabel(): string {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  return process.platform
}

const DETAILED_SYSTEM_INFO = JSON.stringify({
  Os: getOsLabel(),
  Arch: _arch,
  Version: os.version(),
  ProductName: getProductName(),
  MajorVersionNumber: _major,
  MinorVersionNumber: _minor,
  Build: _build,
})

const HARDWARE_INFO = JSON.stringify({
  NumSockets: 1,
  NumCores: _numCores,
  NumThreads: _numCores,
  ModelName: _cpuModel,
  Memory: _totalMemMB,
})

function basicSystemInfo(): string {
  return JSON.stringify({
    Os: process.platform === "win32" ? "windows" : process.platform,
    Arch: process.arch,
    Version: process.version,
    ProductName: process.platform,
  })
}

export function buildWindsurfClientMetadata(opts: {
  apiKey: string
  settings: WindsurfClientSettings
  jwt?: string
  includeHardware?: boolean
  useDetailedSystemInfo?: boolean
}): ProtobufEncoder {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, opts.settings.clientName)
  metadata.writeString(2, opts.settings.appVersion)
  metadata.writeString(3, opts.apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(
    5,
    opts.useDetailedSystemInfo ? DETAILED_SYSTEM_INFO : basicSystemInfo(),
  )
  metadata.writeString(7, opts.settings.lsVersion)
  if (opts.includeHardware) {
    metadata.writeString(8, HARDWARE_INFO)
  }
  metadata.writeString(12, opts.settings.clientName)
  if (opts.jwt) {
    metadata.writeString(21, opts.jwt)
  }
  metadata.writeBytes(30, Uint8Array.from([0, 1]))
  return metadata
}

export function wrapWindsurfMetadataMessage(
  metadata: ProtobufEncoder,
): Uint8Array {
  const outer = new ProtobufEncoder()
  outer.writeMessage(1, metadata)
  return outer.toUint8Array()
}
