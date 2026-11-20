import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto"

import { HTTPError } from "~/lib/error"
import { asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  setCredentialContextField,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { applyOAuthBundleToCredential } from "~/services/oauth/apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import { generateOAuthState } from "~/services/oauth/pkce"
import {
  applyFlowSettingsToConnection,
  createOAuthConnection,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import { codeArtsFetch, codeArtsKeys } from "~/services/codearts/client"
import {
  CODEARTS_IAM,
  codeArtsStations,
  type CodeArtsStation,
} from "~/services/codearts/stations"

export const CODEARTS_STS =
  "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"
const CLIENT_ID = "codearts-agent"

export const codeArtsCallback: OAuthCallbackConfig = {
  port: 18027,
  hostname: "127.0.0.1",
  callbackPath: "/oauth/callback",
  providerLabel: "Huawei CodeArts",
  // Huawei's browser callback returns the code without an OAuth state. STS
  // binds it to the fresh, in-memory PKCE verifier for this pending flow.
  skipStateCheck: true,
  parseQuery(params) {
    const code = params.get("code")
    return code ? { code, state: "" } : undefined
  },
}

const REDIRECT_URI = `http://${codeArtsCallback.hostname}:${codeArtsCallback.port}${codeArtsCallback.callbackPath}`

function stationForRegion(region: string | undefined): CodeArtsStation {
  if (!region || region === "cn" || region === "mainland") return "mainland"
  if (["en", "intl", "international"].includes(region)) return "international"
  throw new HTTPError(
    "Unknown CodeArts station",
    new Response(null, { status: 400 }),
  )
}

function loginUrl(
  station: CodeArtsStation,
  challenge: string,
  ticket: string,
): string {
  const { portal, locale } = codeArtsStations[station]
  const query = new URLSearchParams({
    theme: "2",
    locale,
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(codeArtsCallback.port),
    code_challenge: challenge,
    code_challenge_method: "SHA-256",
    ticket_id: ticket,
    "plugin-name": "snap_AIIDE",
    "plugin-version": "5.2.0",
  })
  const authorize = `${portal}/authorize?${query}`
  return station === "mainland" ? authorize : (
      `https://auth.huaweicloud.com/authui/login?${new URLSearchParams({ site: "intl", locale, service: authorize })}`
    )
}

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")

function dpopProof(serialized: string): string {
  const key = createPrivateKey({ key: JSON.parse(serialized), format: "jwk" })
  const { kty, crv, x, y } = key.export({ format: "jwk" })
  const input = `${b64({ alg: "ES256", typ: "dpop+jwt", jwk: { kty, crv, x, y } })}.${b64({ htm: "POST", htu: CODEARTS_STS, iat: Math.floor(Date.now() / 1000), jti: generateOAuthState() })}`
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`
}

async function requestSts(
  body: Record<string, string>,
  key: string,
  options: OAuthFetchOptions,
) {
  const timeout = AbortSignal.timeout(30_000)
  const signal =
    options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await oauthFetch(
    CODEARTS_STS,
    {
      method: "POST",
      redirect: "error",
      headers: {
        DPoP: dpopProof(key),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
    },
    { ...options, signal },
  )
  const data = asRecord(await response.json().catch(() => undefined))
  const cred = asRecord(data?.credentials)
  const accessToken = asTrimmedString(cred?.access_key_id)
  const secretKey = asTrimmedString(cred?.secret_access_key)
  const securityToken = asTrimmedString(cred?.security_token)
  const expiresAt = Date.parse(asTrimmedString(cred?.expiration) ?? "")
  if (
    !response.ok
    || !accessToken
    || !secretKey
    || !securityToken
    || !Number.isFinite(expiresAt)
  ) {
    const dead =
      body.grant_type === "refresh_token"
      && (data?.error === "invalid_grant"
        || /ExpiredRefreshToken|STS5\.1806|invalid refresh token|refresh token has been used/i.test(
          JSON.stringify(data ?? {}),
        ))
    // The host treats any OAuth 400/401 as terminal. Only a definite refusal
    // of this one-time refresh token warrants that; DPoP and outages don't.
    throw new HTTPError(
      `CodeArts STS ${dead ? "refused the refresh token" : `exchange failed (${response.status})`}`,
      new Response(null, {
        status: dead || body.grant_type !== "refresh_token" ? 400 : 503,
      }),
    )
  }
  return {
    accessToken,
    secretKey,
    securityToken,
    expiresAt,
    refreshToken: asTrimmedString(data?.refresh_token),
  }
}

function readProfile(refreshToken: string | undefined) {
  const segment = refreshToken?.split(".")[1]
  if (!segment) return undefined
  try {
    const payload = asRecord(
      JSON.parse(Buffer.from(segment, "base64url").toString()),
    )
    const profile: unknown = payload?.user_profile
    if (typeof profile !== "string") return asRecord(profile)
    const json =
      profile.startsWith("{") ? profile : (
        Buffer.from(profile, "base64url").toString()
      )
    return asRecord(JSON.parse(json))
  } catch {
    return undefined
  }
}

async function fetchMaskedPhone(
  connection: ProviderConnection,
  userId?: string,
  signal?: AbortSignal,
) {
  if (!userId || !/^[A-Za-z0-9_-]+$/.test(userId)) return undefined
  const keys = codeArtsKeys(connection.credentials[0])
  if (keys.station !== "mainland") return undefined
  const timeout = AbortSignal.timeout(8_000)
  try {
    const response = await codeArtsFetch(connection, keys, {
      url: new URL(`/v3.0/OS-USER/users/${userId}`, CODEARTS_IAM),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const phone = asTrimmedString(
      asRecord(asRecord(await response.json())?.user)?.phone,
    )
    const match = /^(?:\+?86[ -]?)?(1\d{2})\d{4}(\d{4})$/.exec(phone ?? "")
    return match ? `${match[1]}****${match[2]}` : undefined
  } catch {
    signal?.throwIfAborted()
    return undefined // Profile is optional; it does not authorize requests.
  }
}

function applySts(
  connection: ProviderConnection,
  token: Awaited<ReturnType<typeof requestSts>>,
  accountId?: string,
) {
  applyOAuthBundleToCredential(connection, token, { accountId })
  setCredentialContextField(connection, "secretAccessKey", token.secretKey)
  setCredentialContextField(connection, "securityToken", token.securityToken)
}

export const codeArtsOAuth: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start({ region }) {
    const station = stationForRegion(region)
    const state = generateOAuthState()
    const codeVerifier = randomBytes(48).toString("base64url")
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url")
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    return Promise.resolve({
      state,
      pkce: { codeVerifier, codeChallenge },
      redirectUri: REDIRECT_URI,
      authUrl: loginUrl(station, codeChallenge, state),
      // Pending flow nonce, like PKCE, stays in memory and is never exposed.
      nonce: JSON.stringify(privateKey.export({ format: "jwk" })),
    })
  },
  async exchange({ flow, code, signal }) {
    if (!code || !flow.pkce || !flow.nonce)
      throw new Error(
        "CodeArts OAuth flow is missing its code, PKCE verifier, or DPoP key",
      )
    const station = stationForRegion(flow.region)
    const token = await requestSts(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: flow.pkce.codeVerifier,
        redirect_uri: REDIRECT_URI,
      },
      flow.nonce,
      { proxyUrl: flow.proxyUrl, signal },
    )
    if (!token.refreshToken)
      throw new Error("CodeArts STS did not issue a refresh token")
    const profile = readProfile(token.refreshToken)
    const identity =
      asTrimmedString(profile?.principal_urn)
      ?? asTrimmedString(profile?.account_name)
      ?? asTrimmedString(profile?.user_id)
    const connection = createOAuthConnection("codearts", flow.label)
    connection.baseUrl = codeArtsStations[station].snap
    applyFlowSettingsToConnection(connection, flow)
    applySts(connection, token, identity ? `${station}:${identity}` : undefined)
    setCredentialContextField(connection, "codeartsStation", station)
    setCredentialContextField(
      connection,
      "codeartsVerifier",
      flow.pkce.codeVerifier,
    )
    setCredentialContextField(connection, "codeartsDpopKey", flow.nonce)
    const phone = await fetchMaskedPhone(
      connection,
      asTrimmedString(profile?.principal_id ?? profile?.user_id),
      signal,
    )
    if (phone && flow.label === "Huawei CodeArts") connection.name = phone
    return connection
  },
}

export const refreshCodeArts = prepareOAuthRefresh(
  async (connection, refreshToken, options) => {
    const context = connection.credentials[0]?.context
    const verifier = asTrimmedString(context?.codeartsVerifier)
    const dpop = asTrimmedString(context?.codeartsDpopKey)
    if (!verifier || !dpop)
      throw new HTTPError(
        "CodeArts refresh credentials are incomplete; sign in again",
        new Response(null, { status: 401 }),
      )
    const token = await requestSts(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        code_verifier: verifier,
      },
      dpop,
      options,
    )
    applySts(connection, token)
  },
)
