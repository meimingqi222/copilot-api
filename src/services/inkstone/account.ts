import { createHash, randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"

import { isRecord } from "~/lib/json-shape"
import type { OAuthFetchOptions } from "~/services/oauth/fetch"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

import {
  createKey,
  InkstoneRequestError,
  readApiModels,
  readConsole,
  readKeys,
  nonnegative,
} from "~/services/inkstone/client"

const apiKeyPattern = /^sk-[\w-]+$/
const keyLimit = 10

function normalizeApiKey(input: string): string {
  return input
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
}

function normalizeSession(input: string): string {
  const text = input
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
  const value =
    /(?:^|;)\s*uaa-token\s*=\s*([^;]*)/i.exec(text)?.[1]?.trim() ?? text
  if (!/^[\w.~+/%-]+=*$/.test(value))
    throw new Error(
      "Paste the uaa-token cookie entry or its value from the InkStone console.",
    )
  return value
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 4)
}

function isKeyRefused(error: unknown): error is InkstoneRequestError {
  return (
    error instanceof InkstoneRequestError
    && (error.status === 401 || error.status === 403)
  )
}

async function probeKey(
  key: string,
  options: OAuthFetchOptions,
  justCreated = false,
): Promise<void> {
  for (const delay of justCreated ? [0, 1500, 3000, 4500, 6000] : [0]) {
    if (delay) await Bun.sleep(delay)
    try {
      await readApiModels(key, options)
      return
    } catch (error) {
      if (!isKeyRefused(error)) return // A transient outage does not invalidate a key.
      if (!justCreated || delay === 6000) throw error
    }
  }
}

async function mintKey(
  token: string,
  identity: string,
  options: OAuthFetchOptions,
): Promise<string> {
  const listed = await readKeys(token, options)
  if (!isRecord(listed) || !Array.isArray(listed.items))
    throw new Error("InkStone did not return a key list; no key was created.")
  const count = Math.max(
    listed.items.length,
    nonnegative(listed.total ?? listed.total_count) ?? 0,
  )
  if (count >= keyLimit) {
    throw new Error(
      `InkStone already lists ${count} API keys (maximum ${keyLimit}). Paste an existing key or review and remove a key yourself in the InkStone console. No key was deleted.`,
    )
  }
  const name = `ink-${shortHash(hostname())}-${shortHash(identity)}-${randomBytes(2).toString("hex")}`
  try {
    const result = await createKey(token, name, randomUUID(), options)
    const key =
      isRecord(result) && typeof result.key === "string" ?
        normalizeApiKey(result.key)
      : ""
    if (!apiKeyPattern.test(key)) throw new Error("Missing key plaintext")
    await probeKey(key, options, true)
    return key
  } catch {
    // A failed or ambiguous POST may already have created a key. Never retry it or delete it.
    throw new Error(
      `Could not obtain a usable new InkStone key. Check for ${name} in the InkStone console before retrying. No key was deleted.`,
    )
  }
}

export const inkstoneAccountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    try {
      let apiKey = normalizeApiKey(
        credentialString(body, "apiKey", body.apiKey) ?? "",
      )
      const sessionInput = credentialString(body, "uaaToken") ?? ""
      const uaaToken = sessionInput ? normalizeSession(sessionInput) : ""
      if (apiKey && !apiKeyPattern.test(apiKey))
        throw new Error("InkStone Token Plan API keys start with sk-.")
      if (!apiKey && !uaaToken)
        throw new Error(
          "Supply an InkStone Token Plan API key or a console session.",
        )

      const proxyUrl = body.settings?.proxyUrl
      const options = {
        proxyUrl:
          typeof proxyUrl === "string" ?
            proxyUrl.trim() || undefined
          : undefined,
      }
      const [user] = await Promise.all([
        uaaToken ? readConsole("users/validate", uaaToken, options) : undefined,
        apiKey ? probeKey(apiKey, options) : undefined,
      ])
      if (!apiKey && uaaToken && body.settings?.createApiKey === true) {
        const identity =
          isRecord(user) ?
            [
              user.name,
              user.username,
              user.nickname,
              user.phone,
              user.email,
            ].find(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            )
          : undefined
        apiKey = await mintKey(uaaToken, identity ?? uaaToken, options)
      }
      // Consume the consent here. No persisted setting can cause credential writes later.
      const { createApiKey: _createApiKey, ...settings } = body.settings ?? {}
      return {
        id: randomUUID(),
        name: label,
        provider: "inkstone",
        credentials: {
          ...(apiKey && { apiKey }),
          ...(uaaToken && { uaaToken }),
        },
        // An unknown catalogue must not turn this plan into a wildcard route.
        availableModels: [],
        settings,
      }
    } catch (error) {
      return {
        error:
          isKeyRefused(error) ?
            "InkStone refused the supplied credential (401/403)."
          : error instanceof Error ? error.message
          : "InkStone sign-in failed.",
      }
    }
  },
}
