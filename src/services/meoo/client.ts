import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asString, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"

export const MEOO_SITE = "https://meoo.com"
export const MEOO_GATEWAY = "https://api.meoo.host/meoo-ai/compatible-mode/v1"
export const MEOO_CLIENT_ID = "meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh"
const CONTROL = `${MEOO_SITE}/open/v1/cli-compat`

export function projectKey(value: unknown): string | undefined {
  const key = asTrimmedString(value)?.replace(/^Bearer\s+/i, "")
  return key && /^meoo_project_service_v1\.[\x21-\x7e]+$/.test(key) ?
      key
    : undefined
}

export function meooServiceAk(credential?: ApiCredential): string | undefined {
  return (
    projectKey(credential?.context?.serviceAk) ?? projectKey(credential?.value)
  )
}

function meooError(message: string, status: number, body?: string): HTTPError {
  return new HTTPError(message, new Response(null, { status }), body)
}

function deadline(options: OAuthFetchOptions, ms: number): OAuthFetchOptions {
  const timeout = AbortSignal.timeout(ms)
  return {
    ...options,
    signal:
      options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  }
}

export interface MeooTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  openid?: string
}

export async function requestMeooTokens(
  params: Record<string, string>,
  options: OAuthFetchOptions,
): Promise<MeooTokens> {
  const res = await oauthFetch(
    `${MEOO_SITE}/oauth/token`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        ...params,
        client_id: MEOO_CLIENT_ID,
      }).toString(),
    },
    deadline(options, 20_000),
  )
  const data = asRecord(await res.json().catch(() => undefined))
  if (!res.ok) {
    const error = asString(data?.error)
    const safeError =
      (
        error
        && /^(?:invalid_grant|invalid_client|invalid_refresh_token|unauthorized_client|temporarily_unavailable|server_error)$/.test(
          error,
        )
      ) ?
        error
      : undefined
    const status =
      res.status === 403 ? 401
      : res.status >= 300 && res.status < 400 ? 502
      : res.status
    throw meooError(
      `Meoo OAuth token request failed (HTTP ${status}).`,
      status,
      safeError,
    )
  }
  const accessToken = asTrimmedString(data?.access_token)
  if (
    !accessToken
    || !/^[\x21-\x7e]+$/.test(accessToken)
    || projectKey(accessToken)
  )
    throw new Error("Meoo did not return a valid OAuth access token.")
  const expiresIn = asNumber(data?.expires_in) ?? 3600
  if (expiresIn <= 0 || !Number.isSafeInteger(expiresIn * 1000))
    throw new Error("Invalid Meoo OAuth token lifetime.")
  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: asTrimmedString(data?.refresh_token),
    scope: asTrimmedString(data?.scope),
    openid: asTrimmedString(data?.openid),
  }
}

type ControlPath =
  | "/account/identity"
  | "/projects?page_size=50"
  | `/projects/${string}/cloud/environment`
  | "/account/points"
  | "/account/entitlement"

async function meooControl(
  path: ControlPath,
  access: string,
  options: OAuthFetchOptions,
): Promise<unknown> {
  const res = await oauthFetch(
    `${CONTROL}${path}`,
    {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${access}`,
        "x-meoo-client": "cli",
        "x-meoo-cli-version": "0.5.6",
      },
    },
    deadline(options, 20_000),
  )
  if (!res.ok) {
    await res.body?.cancel()
    const status = res.status >= 300 && res.status < 400 ? 502 : res.status
    throw meooError(`Meoo control request failed (HTTP ${status}).`, status)
  }
  const data: unknown = await res.json()
  const object = asRecord(data)
  if (object?.success === false)
    throw meooError("Meoo rejected the control request.", 502)
  return object?.data ?? data
}

export async function resolveMeooProject(
  access: string,
  options: OAuthFetchOptions,
  explicit?: string,
) {
  const identity = asRecord(
    await meooControl("/account/identity", access, options),
  )
  let projectUrlId =
    explicit
    ?? asTrimmedString(identity?.project_url_id ?? identity?.projectUrlId)
  if (!projectUrlId) {
    const projects = await meooControl(
      "/projects?page_size=50",
      access,
      options,
    )
    const fields = asRecord(projects)
    const list = fields?.list ?? fields?.items ?? fields?.projects ?? projects
    if (
      !Array.isArray(list)
      || list.length !== 1
      || (asNumber(fields?.total) ?? 1) > 1
      || fields?.has_more === true
      || fields?.hasMore === true
    ) {
      throw new Error(
        "Set one default project on meoo.com or supply its project service AK.",
      )
    }
    const single = asRecord(list[0])
    projectUrlId = asTrimmedString(single?.url_id ?? single?.urlId)
  }
  if (!projectUrlId || !/^[\w-]{1,160}$/.test(projectUrlId))
    throw new Error("Meoo did not return a valid project ID.")
  const env = asRecord(
    await meooControl(
      `/projects/${projectUrlId}/cloud/environment`,
      access,
      options,
    ),
  )
  const serviceAk = projectKey(
    env?.meooProjectApiKey ?? asRecord(env?.instance)?.meooProjectApiKey,
  )
  if (!serviceAk)
    throw new Error(
      "Enable cloud services for the project on meoo.com, then sign in again.",
    )
  return { projectUrlId, serviceAk, userId: asTrimmedString(identity?.user_id) }
}

function nonNegative(value: unknown): number | undefined {
  const n = asNumber(value)
  return n !== undefined && n >= 0 ? n : undefined
}

function firstExpiry(grants: unknown): number | undefined {
  if (!Array.isArray(grants)) return undefined
  let earliest: number | undefined
  for (const grant of grants as Array<unknown>) {
    const details = asRecord(grant)?.grantDetails
    if (!Array.isArray(details)) continue
    for (const detail of details as Array<unknown>) {
      const record = asRecord(detail)
      if (!(Number(record?.remainingAmount) > 0)) continue
      const date = Date.parse(asString(record?.expiresDate) ?? "")
      if (Number.isFinite(date) && (earliest === undefined || date < earliest))
        earliest = date
    }
  }
  return earliest
}

export async function fetchMeooQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot> {
  const access = connection.credentials[0]?.value
  const base = { provider: "meoo", fetchedAt: Date.now(), unlimited: false }
  if (!access || projectKey(access))
    return { ...base, allowance: { state: "unsupported", windows: [] } }
  const options = { proxyUrl: getConnectionProxyUrl(connection), signal }
  const [points, entitlement] = await Promise.all([
    meooControl("/account/points", access, options),
    meooControl("/account/entitlement", access, options)
      .then(asRecord)
      .catch(() => undefined),
  ])
  const data = asRecord(points)
  const account = asRecord(data?.account)
  const remaining = nonNegative(account?.availableBalance)
  const benefits = entitlement?.benefits
  const daily =
    Array.isArray(benefits) ?
      (benefits as Array<unknown>)
        .map(asRecord)
        .find(
          (item) =>
            item?.typeCode === "daily_login"
            || item?.typeName === "每日登录赠送积分",
        )
    : undefined
  return {
    ...base,
    allowance:
      remaining === undefined ?
        { state: "unknown", windows: [] }
      : {
          state: "known",
          windows: [{ id: "points", unit: "credits", remaining }],
        },
    details: {
      // The earliest grant expiry is informational, not a deadline on the whole wallet.
      nextGrantExpiryMs: firstExpiry(data?.activeGrants),
      pointsUsed: nonNegative(account?.totalConsumed),
      pointsFrozen: nonNegative(account?.frozenBalance),
      dailyLoginPoints: asNumber(daily?.quota),
      dailyLoginGranted: entitlement?.dailyLoginGranted === true,
    },
  }
}
