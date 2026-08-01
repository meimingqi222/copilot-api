/**
 * Claude Code `metadata.user_id` fingerprinting.
 *
 * Real Claude Code sends `metadata.user_id` in two shapes, both reproduced
 * here so OAuth traffic through copilot-api matches the official CLI's
 * attribution:
 *
 * 1. Cloaking string: `user_<64hex>_account_<uuid>_session_<uuid>`
 * 2. JSON envelope: `JSON.stringify({ device_id, session_id, account_uuid? })`
 *
 * The `device_id` is a STABLE SHA-256 hash derived from the install id (+ the
 * account id when available), not a fresh random value per request. A random
 * per-request device id would inflate the backend's session/device count and
 * look bot-like. The install id is persisted across restarts (see
 * `~/lib/install-id`).
 *
 * For OAuth tokens, a caller-supplied `user_id` is forwarded verbatim ONLY if
 * it already matches one of the CC shapes; otherwise it is dropped and a fresh
 * CC-style JSON id is generated from the session/account id, keeping
 * attribution consistent.
 *
 * Ported from oh-my-pi packages/ai/src/providers/anthropic.ts (647-766).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto"

import { getInstallId } from "~/lib/install-id"

const CLAUDE_CLOAKING_USER_ID_REGEX =
  /^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isClaudeCloakingUserId(userId: string): boolean {
  return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId)
}

/**
 * Real Claude Code also sends `metadata.user_id` as a JSON-stringified object
 * of the shape `{ device_id, account_uuid, session_id, ...extra }`. Accept
 * that shape so callers that supply a stable `session_id` aren't silently
 * overwritten with fresh entropy on every request.
 */
export function isClaudeJsonUserId(userId: string): boolean {
  if (userId.length === 0 || userId[0] !== "{") return false
  let parsed: unknown
  try {
    parsed = JSON.parse(userId)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false
  const obj = parsed as Record<string, unknown>
  return typeof obj.session_id === "string" && obj.session_id.length > 0
}

/** Returns true if `userId` matches either CC attribution shape. */
export function isClaudeCodeUserId(userId: string): boolean {
  return isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)
}

/** Extracts the Claude Code session id from either supported user_id shape. */
export function extractClaudeMetadataSessionId(
  userId: unknown,
): string | undefined {
  if (typeof userId !== "string") return undefined
  if (isClaudeCloakingUserId(userId)) {
    return userId.slice(userId.lastIndexOf("_session_") + "_session_".length)
  }
  if (!isClaudeJsonUserId(userId)) return undefined
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown }
    return (
        typeof parsed.session_id === "string" && parsed.session_id.length > 0
      ) ?
        parsed.session_id
      : undefined
  } catch {
    return undefined
  }
}

export function generateClaudeCloakingUserId(): string {
  const userHash = randomBytesHex(32)
  const accountId = randomUUID().toLowerCase()
  const sessionId = randomUUID().toLowerCase()
  return `user_${userHash}_account_${accountId}_session_${sessionId}`
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "copilot-api-claude-device-id-v1:"
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "copilot-api-claude-device-id-v2"

/**
 * Derives a stable device id from the install id (+ optional account id).
 * Same inputs always produce the same SHA-256, so the device fingerprint is
 * consistent across requests and restarts. When `accountId` is present, a
 * domain-separated hash (v2) is used so different accounts on the same install
 * get distinct device ids.
 */
export function deriveClaudeDeviceId(
  installId: string,
  accountId?: string,
): string {
  const hash = createHash("sha256")
  if (accountId && accountId.length > 0) {
    return hash
      .update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
      .update("\0")
      .update(installId)
      .update("\0")
      .update(accountId)
      .digest("hex")
  }
  return hash
    .update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN)
    .update(installId)
    .digest("hex")
}

async function deriveClaudeDeviceIdFromInstallId(
  accountId?: string,
): Promise<string> {
  return deriveClaudeDeviceId(await getInstallId(), accountId)
}

/**
 * Generates a CC-style JSON `user_id` envelope.
 * `{ device_id: <stable sha256>, session_id, account_uuid? }`
 */
export async function generateClaudeJsonUserId(
  sessionId?: string,
  accountId?: string,
): Promise<string> {
  const userId: Record<string, string> = {
    device_id: await deriveClaudeDeviceIdFromInstallId(accountId),
    session_id: sessionId ?? randomUUID().toLowerCase(),
  }
  if (accountId && accountId.length > 0) {
    userId.account_uuid = accountId
  }
  return JSON.stringify(userId)
}

/**
 * Resolve the `metadata.user_id` field for an Anthropic Messages request.
 *
 * For OAuth tokens the value MUST match the Claude Code attribution shape
 * (`isClaudeCloakingUserId` or the JSON envelope) - anything else is dropped
 * and a fresh CC-style JSON id is generated from `sessionId`/`accountId` so
 * attribution stays consistent across the conversation.
 *
 * For non-OAuth tokens (API key), an explicit caller-supplied `userId` is
 * forwarded verbatim and `undefined` yields no metadata.
 */
export async function resolveAnthropicMetadataUserId(
  userId: unknown,
  isOAuthToken: boolean,
  sessionId?: string,
  accountId?: string,
): Promise<string | undefined> {
  if (
    typeof userId === "string"
    && (!isOAuthToken || isClaudeCodeUserId(userId))
  ) {
    return userId
  }
  if (!isOAuthToken) return undefined
  return generateClaudeJsonUserId(sessionId, accountId)
}

function randomBytesHex(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}
