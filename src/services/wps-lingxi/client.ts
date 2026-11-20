import { createHash, randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import type { ApiCredential } from "~/lib/provider-connections"
import { readResponseBytes } from "~/lib/request-body"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"

export const WPS_ORIGINS = [
  "https://lingxi.wps.cn",
  "https://lingxi.kdocs.cn",
] as const
export const WPS_PATHS = {
  profile: "/api/public/v1/account/profile",
  balance: "/api/public/v1/credits/balance",
  models: "/api/aioffice/v1/sessions/plans",
  session: "/api/aioffice/v1/cowork/sessions",
  run: "/api/public/v1/credits/runs",
  chat: "/api/public/v1/agent-runtime/chat/completions",
} as const

type Origin = (typeof WPS_ORIGINS)[number]
export const WPS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

export function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" && !Number.isSafeInteger(value))
    return undefined
  const text = String(value).trim()
  return text && /^[\x21-\x7e]+$/.test(text) ? text : undefined
}

export function cookieInput(input: string): string | undefined {
  if (/[\r\n]/.test(input) || input.includes("\0") || input.length > 16384)
    return undefined
  const text = input
    .trim()
    .replace(/^cookie:\s*/i, "")
    .replace(/^(["'])(.*)\1$/, "$2")
  const pairs = new Map<string, string>()
  for (const part of text.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    const value = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
    if (value && /^[\x21-\x7e]+$/.test(value) && !/[",;\\]/.test(value))
      pairs.set(name, value)
  }
  const sid =
    pairs.get("wps_sid") ?? (/^[\w+/%.:-]+={0,2}$/.test(text) ? text : "")
  if (sid.length < 16) return undefined
  return [
    `wps_sid=${sid}`,
    ...["uid", "copilot_server_branch"].flatMap((key) =>
      pairs.has(key) ? [`${key}=${pairs.get(key)}`] : [],
    ),
  ].join("; ")
}

function officialOrigin(value: unknown): Origin | undefined {
  return WPS_ORIGINS.find((origin) => value === origin)
}

export class LingxiError extends HTTPError {
  readonly reason: string
  readonly staleRun: boolean

  constructor(
    status: number,
    reason = "upstream_error",
    staleRun = false,
    headers?: Headers,
  ) {
    const message =
      reason === "audit_blocked" ?
        "WPS Lingxi blocked this request during content review"
      : status === 401 ?
        "WPS Lingxi sign-in expired or is invalid; enter a new wps_sid"
      : `WPS Lingxi upstream error (${reason})`
    const retry = new Headers()
    for (const key of ["retry-after", "retry-after-ms", "x-ratelimit-reset"]) {
      const value = headers?.get(key)
      if (value) retry.set(key, value)
    }
    super(
      message,
      new Response(null, { status, headers: retry }),
      JSON.stringify({
        error: { message, code: reason, type: "upstream_error" },
      }),
    )
    this.reason = reason
    this.staleRun = staleRun
  }
}

/** Keep upstream error text out of logs/responses: a rejected request can echo input or cookies. */
export function envelopeFailure(
  value: unknown,
  status = 200,
  headers?: Headers,
): LingxiError | undefined {
  const v = record(value)
  const nested = record(v.error)
  const detail = [
    v.code,
    v.result,
    v.message,
    v.msg,
    v.hint,
    v.error,
    nested.code,
    nested.message,
    typeof value === "string" ? value : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
  if (/\bAuditFailed\b|\baudit_blocked\b|暂时无法回答此问题/i.test(detail))
    return new LingxiError(400, "audit_blocked")
  const code = String(v.code ?? nested.code ?? v.result ?? "").toLowerCase()
  if (code === "userunauthorized" || status === 401)
    return new LingxiError(401, "sign_in_required")
  if (code === "permissiondenied")
    return new LingxiError(403, "PermissionDenied")
  if (code === "invalidargument") return new LingxiError(400, "InvalidArgument")
  const staleRun =
    /sqlnorows|no rows|会话不存在|数据不存在|session.*not found/i.test(detail)
  const failed = code && !["success", "ok", "0"].includes(code)
  if (!staleRun && !failed && !v.error && status >= 200 && status < 300)
    return undefined
  const mapped =
    staleRun || [400, 404, 422].includes(status) ? 404
    : status < 400 ? 502
    : status
  return new LingxiError(
    mapped,
    staleRun ? "stale_run" : "upstream_error",
    staleRun,
    headers,
  )
}

export function credentialClient(
  credential: ApiCredential,
  options: OAuthFetchOptions,
) {
  const origin = officialOrigin(credential.context?.origin)
  const cookie = cookieInput(credential.value)
  if (!origin || !cookie) throw new LingxiError(401, "sign_in_required")
  return new LingxiClient(origin, cookie, options)
}

export class LingxiClient {
  readonly origin: Origin
  private readonly cookie: string
  private readonly options: OAuthFetchOptions
  private readonly deviceId: string
  private readonly region: string | undefined

  constructor(origin: Origin, cookie: string, options: OAuthFetchOptions) {
    this.origin = origin
    this.cookie = cookie
    this.options = options
    this.deviceId = createHash("sha256")
      .update(`wps-lingxi:${cookie.split(";", 1)[0]}`)
      .digest("hex")
    this.region = /(?:^|; )copilot_server_branch=([^;]+)/.exec(cookie)?.[1]
  }

  cookieHeader(): string {
    return `${this.cookie}; x-kso-app-name=win-lingxi-desktop; x-kso-app-version=1.3.31; x-kso-device-id=${this.deviceId}`
  }

  private async request(
    path: (typeof WPS_PATHS)[keyof typeof WPS_PATHS],
    body?: Record<string, unknown>,
    extra?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Cookie: this.cookieHeader(),
      "User-Agent": WPS_UA,
      Referer: `${this.origin}/`,
      Accept:
        path === WPS_PATHS.chat ? "text/event-stream" : "application/json",
      ...(body && {
        "Content-Type": "application/json",
        "X-Client-Type": "lingxi_claw",
        "X-Client-Lang": "zh-CN",
        "X-Cc-Agent-Type": "lingxi_claw",
        "X-Request-Id": randomUUID(),
        ...(this.region && { "X-Cc-Region": this.region }),
      }),
      ...extra,
    }
    return oauthFetch(
      `${this.origin}${path}`,
      {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // Do not let Bun forward an explicit Cookie to any redirect target.
        redirect: "manual",
      },
      this.options,
    )
  }

  async json(
    path: Exclude<
      (typeof WPS_PATHS)[keyof typeof WPS_PATHS],
      typeof WPS_PATHS.chat
    >,
    body?: Record<string, unknown>,
  ) {
    return readEnvelope(await this.request(path, body))
  }

  async chat(
    run: { sessionId: string; runId: string },
    body: Record<string, unknown>,
  ) {
    const response = await this.request(WPS_PATHS.chat, body, {
      "x-cc-session-id": run.sessionId,
      "x-cc-run-id": run.runId,
    })
    if (
      !response.ok
      || !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await readEnvelope(response)
      throw new LingxiError(502, "invalid_stream")
    }
    if (!response.body) throw new LingxiError(502, "invalid_stream")
    return response.body
  }

  async session(type: "cowork_client" | "cowork_web" = "cowork_client") {
    const data = await this.json(WPS_PATHS.session, {
      session_type: type,
      agent_version: 2,
      env: {
        device_id: this.deviceId,
        device_name: "copilot-api",
        work_space_dir: "/tmp",
      },
    })
    const sessionId = identifier(data.session_id)
    if (!sessionId || !/^[\w-]+$/.test(sessionId))
      throw new LingxiError(502, "missing_session_id")
    return sessionId
  }
}

async function readEnvelope(
  response: Response,
): Promise<Record<string, unknown>> {
  let bytes: Uint8Array
  try {
    bytes = await readResponseBytes(response, 1024 * 1024)
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 413)
      throw error
    throw (
      envelopeFailure(undefined, response.status, response.headers)
      ?? new LingxiError(502, "invalid_response")
    )
  }
  const text = new TextDecoder().decode(bytes)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  const failure = envelopeFailure(payload, response.status, response.headers)
  if (failure) throw failure
  const data = record(payload).data
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new LingxiError(502, "invalid_response")
  return record(data)
}
