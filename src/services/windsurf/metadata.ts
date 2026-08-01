import { ProtobufEncoder } from "./protobuf"

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"
const DEVIN_IDE_VERSION = "3.2.23"
const DEVIN_EXTENSION_VERSION = "1.48.2"

/**
 * Normalize a Windsurf/Devin API key to the `devin-session-token$<jwt>` format
 * that the Codeium server expects in Metadata.api_key (field 3).
 */
export function normalizeDevinApiKey(apiKey: string): string {
  if (apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return apiKey
  return `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`
}

/**
 * Build Windsurf client Metadata exactly like oh-my-pi's Devin provider.
 *
 * Field layout (verified from oh-my-pi packages/ai/src/providers/devin.ts):
 *   f1=ide_name "windsurf"
 *   f2=extension_version "1.48.2"
 *   f3=api_key  (devin-session-token$<jwt>)
 *   f4=locale "en"
 *   f7=ide_version "3.2.23"
 *   f12=extension_name "windsurf"
 *   f21=user_jwt (the short-lived JWT from GetUserJwt; present on chat requests)
 *
 * Deliberately omits f5(os), f8(hardware), f9(requestId), f10(sessionId),
 * f16(timestamp), f28(ideType), f30(platform_id), f31(f) - oh-my-pi does not
 * send them, and the extra fields create an anomalous fingerprint that can
 * trigger per-model rate limits.
 *
 * `userJwt` is the short-lived JWT obtained from the two-stage `GetUserJwt`
 * exchange (see `fetchDevinUserJwt`). Real Windsurf sends it on every chat
 * request (oh-my-pi devin.ts line 514), so it is part of the wire fingerprint.
 */
export function buildWindsurfClientMetadata(
  apiKey: string,
  userJwt?: string,
): ProtobufEncoder {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, "windsurf")
  metadata.writeString(2, DEVIN_EXTENSION_VERSION)
  metadata.writeString(3, normalizeDevinApiKey(apiKey))
  metadata.writeString(4, "en")
  metadata.writeString(7, DEVIN_IDE_VERSION)
  metadata.writeString(12, "windsurf")
  if (userJwt) {
    metadata.writeString(21, userJwt)
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
