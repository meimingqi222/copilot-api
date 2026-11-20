import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { HTTPError } from "~/lib/error"
import { asRecord, asTrimmedString } from "~/lib/json-shape"
import type { ProviderConnection } from "~/lib/provider-connections"
import { applyOAuthBundleToCredential } from "~/services/oauth/apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import { extractJwtExpiryMs, parseJwtPayload } from "~/services/oauth/jwt"
import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

export const RACCOON_ORIGIN = "https://xiaohuanxiong.com"
export const RACCOON_LLM = `${RACCOON_ORIGIN}/api/web/llm/v2`

function parseCallback(params: URLSearchParams) {
  const state = params.get("state") ?? ""
  const code = params.get("code")?.trim()
  if (
    !/^[a-f0-9]{64}$/.test(state)
    || !code
    || code.length > 4096
    || params.getAll("state").length !== 1
    || params.getAll("code").length !== 1
    || params.has("error")
    || code.includes("\0")
  )
    return undefined
  return { state, code: `${state}\0${code}` }
}

export const raccoonCallback: OAuthCallbackConfig = {
  port: 59657,
  hostname: "127.0.0.1",
  callbackPath: "/auth/callback",
  providerLabel: "SenseTime Raccoon",
  parseQuery: parseCallback,
}

export function startRaccoonLogin() {
  const state = randomBytes(32).toString("hex")
  const redirectUri = `http://${raccoonCallback.hostname}:${raccoonCallback.port}${raccoonCallback.callbackPath}`
  const url = new URL("/code/authorize", RACCOON_ORIGIN)
  url.search = new URLSearchParams({
    login_source: "desktop",
    appname: "办公小浣熊客户端",
    state,
    desktop_callback: "loopback",
    redirect: redirectUri,
  }).toString()
  return { state, authUrl: url.toString(), redirectUri }
}

function bearer(value: unknown): string | undefined {
  const token = asTrimmedString(value)?.replace(/^Bearer\s+/i, "")
  return token && token.length <= 8192 && /^[\x21-\x7e]+$/.test(token) ?
      token
    : undefined
}

export function raccoonIdentity(token: string): string | undefined {
  const claims = parseJwtPayload(token)
  const name = asTrimmedString(claims?.name)
  if (name?.startsWith("Raccoon-")) return name
  for (const key of ["sid", "iss"]) {
    const id = asTrimmedString(claims?.[key])?.replace(/^0x/i, "")
    if (id && /^[\da-f]+$/i.test(id)) return BigInt(`0x${id}`).toString()
  }
  return asTrimmedString(claims?.sub ?? claims?.id ?? claims?.user_id) ?? name
}

interface RaccoonTokens {
  accessToken: string
  refreshToken?: string
}

export async function readRaccoonDesktopToken(): Promise<string | undefined> {
  const home = homedir()
  const config =
    process.env.RACCOON_BOX_AGENT_CONFIG_DIR || process.env.BOX_AGENT_CONFIG_DIR
  const data =
    process.platform === "darwin" ? join(home, "Library", "Application Support")
    : process.platform === "win32" ?
      process.env.APPDATA || join(home, "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || join(home, ".config")
  const paths =
    config ?
      [join(config, "auth.json")]
    : [
        ...(process.platform === "win32" ?
          [join(home, ".office-raccoon", "agent", "config", "auth.json")]
        : []),
        join(data, "office-raccoon", "agent", "config", "auth.json"),
        join(home, ".box-agent", "config", "auth.json"),
      ]
  for (const path of paths) {
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    if (file.size > 256 * 1024) return undefined
    return bearer(asRecord(await file.json())?.access_token)
  }
  return undefined
}

function readTokens(input: unknown): RaccoonTokens | undefined {
  const row = asRecord(input)
  const accessToken = bearer(row?.access_token ?? row?.accessToken)
  if (!accessToken) return undefined
  // A pasted desktop snapshot is never a refresh grant for this proxy.
  const refreshToken =
    row?.source === "desktop" ?
      undefined
    : bearer(row?.refresh_token ?? row?.refreshToken)
  return { accessToken, refreshToken }
}

export async function resolveRaccoonLogin(
  input: string,
  state: string,
  options?: OAuthFetchOptions,
): Promise<RaccoonTokens> {
  if (input.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      throw new Error("Invalid Raccoon credential JSON")
    }
    const tokens = readTokens(parsed)
    if (tokens) return tokens
    throw new Error("Raccoon credentials are missing access_token")
  }
  const direct = bearer(input)
  if (direct?.split(".").length === 3 && parseJwtPayload(direct))
    return { accessToken: direct }
  const [returnedState, code, extra] = input.split("\0")
  if (
    !state
    || returnedState !== state
    || !code
    || code.length > 4096
    || extra !== undefined
  ) {
    throw new Error(
      "Paste the complete Raccoon callback with the state from this login, or paste credentials",
    )
  }
  const tokens = await raccoonTokenRequest(
    "login_with_authorization_code",
    { authorization_code: code },
    options,
  )
  if (!tokens.refreshToken)
    throw new Error("Raccoon login returned no refresh token")
  return tokens
}

async function raccoonTokenRequest(
  path: string,
  body: Record<string, string>,
  options?: OAuthFetchOptions,
): Promise<RaccoonTokens> {
  const response = await oauthFetch(
    `${RACCOON_ORIGIN}/api/web/auth/v1/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
    options,
  )
  const payload = asRecord(await response.json().catch(() => undefined))
  const code = payload?.code
  if (!response.ok || (code !== undefined && code !== 0)) {
    const status =
      [200001, 200003, 200035].includes(Number(code)) ? 401
      : response.ok ? 502
      : response.status
    throw new HTTPError(
      `Raccoon token request failed (${status})`,
      new Response(null, { status }),
    )
  }
  const tokens = readTokens(payload?.data)
  if (!tokens) throw new Error("Raccoon token response is missing access_token")
  return tokens
}

export function applyRaccoonTokens(
  connection: ProviderConnection,
  tokens: RaccoonTokens,
): void {
  applyOAuthBundleToCredential(
    connection,
    { ...tokens, expiresAt: extractJwtExpiryMs(tokens.accessToken) },
    { accountId: raccoonIdentity(tokens.accessToken) },
  )
}

export async function renewRaccoonTokens(
  connection: ProviderConnection,
  refreshToken: string,
  options: OAuthFetchOptions,
): Promise<void> {
  const current = raccoonIdentity(connection.credentials[0]?.value ?? "")
  const tokens = await raccoonTokenRequest(
    "refresh",
    { refresh_token: refreshToken },
    options,
  )
  if (current && raccoonIdentity(tokens.accessToken) !== current)
    throw new Error("Raccoon refresh returned a different account")
  applyRaccoonTokens(connection, tokens)
}
