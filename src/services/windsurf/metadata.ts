import { ProtobufEncoder } from "./protobuf"

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"

/**
 * Connect-RPC `user-agent` every Devin/Windsurf call announces. The real
 * clients are Go (`chisel`) and speak connect-go, and this string is
 * byte-identical to the oh-my-pi reference
 * (`packages/ai/src/providers/devin.ts`). Every call site — chat, model
 * catalog, quota — must send the same one: a UA on some calls and none on
 * others is itself a fingerprint.
 */
export const WINDSURF_CONNECT_USER_AGENT = "connect-go/1.18.1 (go1.26.3)"

/**
 * `Metadata.os` (field 5) vocabulary. oh-my-pi maps `process.platform` down to
 * three words; the backend only ever sees this normalized form.
 */
function devinOs(): string {
  switch (process.platform) {
    case "darwin": {
      return "darwin"
    }
    case "win32": {
      return "windows"
    }
    default: {
      return "linux"
    }
  }
}

/** One wire identity tuple (`exa.codeium_common_pb.Metadata`). */
export interface WindsurfClientIdentity {
  /** Metadata.ide_name (field 1) */
  ideName: string
  /** Metadata.ide_version (field 7) */
  ideVersion: string
  /** Metadata.extension_name (field 12) */
  extensionName: string
  /** Metadata.extension_version (field 2) */
  extensionVersion: string
  /** Metadata.ide_type (field 28) — omitted when undefined */
  ideType?: string
  /** Metadata.os (field 5) — omitted when undefined */
  os?: string
}

/**
 * Released Devin CLI identity (`chisel`), used for chat, `GetUserJwt` and the
 * quota probe.
 *
 * The backend gates behaviour on this tuple: `ideType: "chisel"` is what
 * unlocks router assignment (`AssignModel`) and the CLI model surface, which
 * the legacy Windsurf editor identity does not reach. Field layout is taken
 * from oh-my-pi's `DEVIN_CLI_METADATA`
 * (`packages/catalog/src/wire/devin.ts`, captured from the released binary);
 * the version is the newest pin seen in the wild (CPA
 * `DevinDefaultClientVersion`), because a stale pin is what makes the backend
 * answer an empty-but-200 catalog.
 */
export const DEVIN_CLI_IDENTITY: WindsurfClientIdentity = {
  ideName: "devin-cli",
  ideVersion: "3000.10.21",
  extensionName: "chisel",
  extensionVersion: "3000.10.21",
  ideType: "chisel",
  os: devinOs(),
}

/**
 * Legacy Windsurf editor identity, used for the model catalog only.
 *
 * Catalog reads stay on this tuple because this proxy gets its roster from
 * `GetUserStatus` rather than from `GetCliModelConfigs` (the RPC the reference
 * implementations gate on the CLI identity), and the editor identity is the
 * one that has always returned the full credential-scoped roster here — legacy
 * Enterprise seats are documented to publish theirs only to it (oh-my-pi
 * `packages/catalog/src/discovery/devin.ts`). Chat and quota use
 * `DEVIN_CLI_IDENTITY` instead.
 */
export const WINDSURF_EDITOR_IDENTITY: WindsurfClientIdentity = {
  ideName: "windsurf",
  ideVersion: "3.2.23",
  extensionName: "windsurf",
  extensionVersion: "1.48.2",
}

/**
 * Normalize a Windsurf/Devin API key to the `devin-session-token$<jwt>` format
 * that the Codeium server expects in Metadata.api_key (field 3).
 */
export function normalizeDevinApiKey(apiKey: string): string {
  if (apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return apiKey
  return `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`
}

/**
 * Build the client Metadata block (request field 1) for a Devin call.
 *
 * Field layout (`exa.codeium_common_pb.Metadata`):
 *   f1=ide_name, f2=extension_version, f3=api_key
 *   (devin-session-token$<jwt>), f4=locale, f5=os, f7=ide_version,
 *   f12=extension_name, f21=user_jwt, f28=ide_type
 *
 * `userJwt` is the short-lived JWT from the two-stage `GetUserJwt` exchange
 * (see `fetchDevinUserJwt`). Real clients send it on chat requests and omit it
 * on the unary auth/assign/status calls, so it is part of the fingerprint.
 *
 * Deliberately omits f8(hardware), f9(requestId), f10(sessionId),
 * f16(lsTimestamp), f24(deviceFingerprint), f30(supportedModelDisplays) and
 * f31(`f`) — the released CLI capture does not send them, and the extra fields
 * create an anomalous fingerprint that can trigger per-model rate limits. CPA
 * does send a 732-hex f31, but it generates a fresh random blob per request
 * when no device seed is stored, which no real device fingerprint does.
 */
export function buildWindsurfClientMetadata(
  apiKey: string,
  userJwt?: string,
  identity: WindsurfClientIdentity = DEVIN_CLI_IDENTITY,
): ProtobufEncoder {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, identity.ideName)
  metadata.writeString(2, identity.extensionVersion)
  metadata.writeString(3, normalizeDevinApiKey(apiKey))
  metadata.writeString(4, "en")
  if (identity.os) {
    metadata.writeString(5, identity.os)
  }
  metadata.writeString(7, identity.ideVersion)
  metadata.writeString(12, identity.extensionName)
  if (userJwt) {
    metadata.writeString(21, userJwt)
  }
  if (identity.ideType) {
    metadata.writeString(28, identity.ideType)
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
