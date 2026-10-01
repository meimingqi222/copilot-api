import type { Server } from "bun"

import fs from "node:fs/promises"

import type { OAuthProviderId } from "~/lib/provider-config"

import { logger } from "~/lib/logger"
import { assertWritableDataPath, PATHS } from "~/lib/paths"

import type { CodebuddyOAuthProviderId } from "./codebuddy"
import type { PkceCodes } from "./pkce"

import { LOBSTERAI_CALLBACK_PATH, LOBSTERAI_CALLBACK_PORT } from "./lobsterai"
import { WINDSURF_CALLBACK_PATH, WINDSURF_CALLBACK_PORT } from "./windsurf"
import {
  COMMANDCODE_CALLBACK_PATH,
  COMMANDCODE_CALLBACK_PORT,
} from "./commandcode"
import { ZED_CALLBACK_PORT, ZED_SIGNIN_SUCCEEDED_URL } from "./zed"
import { DIMAGENT_CALLBACK_PATH, DIMAGENT_CALLBACK_PORT } from "./dimagent"
import { GEMINI_CALLBACK_PATH, GEMINI_CALLBACK_PORT } from "./gemini"

export type OAuthFlowProvider =
  | OAuthProviderId
  | "windsurf"
  | "lobsterai"
  | "commandcode-plan"
  | "zed"
  | "dimagent"
  | "gemini"
  | CodebuddyOAuthProviderId

export interface OAuthPendingFlow {
  id: string
  provider: OAuthFlowProvider
  label: string
  status: "pending" | "exchanging" | "complete" | "expired" | "error"
  expiresAt: number
  interval?: number
  authUrl?: string
  verificationUri?: string
  userCode?: string
  accountId?: string
  error?: string
  state?: string
  nonce?: string
  pkce?: PkceCodes
  deviceCode?: string
  deviceId?: string
  tokenEndpoint?: string
  redirectUri?: string
  proxyUrl?: string
  /**
   * Provider 专属账号域（目前只有 MiniMax Code：`cn` / `en`）。
   * 设备码 flow 在 start 时存入，exchange 轮询 token 端点要用同一个区域。
   */
  region?: string
  /**
   * 原地重认证目标 connection id。exchange 完成后把新 token bundle
   * 写回该 connection（保留 id/label/用量统计），而不是新建账号。
   */
  reauthAccountId?: string
  /**
   * In-memory only: device-code `expires_in` (seconds) returned by the
   * device-authorization endpoint. Not persisted (excluded from
   * `flowForPersistence`) so the persistence format stays unchanged.
   * Used by the kimi strategy to bound the polling deadline to the
   * device code's actual lifetime.
   */
  deviceExpiresIn?: number
  /**
   * 创建时刻，用于判定残留 pending flow 是否可被新的 start 替换。
   * 持久化格式里缺失时按"陈旧"处理——重启后从磁盘载入的 flow 正是没人再
   * poll 的那种。
   */
  createdAt?: number
}

/**
 * 残留 pending flow 的可替换窗口。
 *
 * 浏览器侧丢了 flowId（或管理端会话在进程重启后失效导致 poll 拿不到结果）时，
 * 这个 flow 会一直占着 provider 级互斥，让用户永久卡在
 * "An OAuth flow for <provider> is already in progress."——实测卡满 15 分钟 TTL，
 * 且 flow 是持久化的，重启也不会自愈。刚创建 60 秒内的 flow 仍视为"用户正在
 * 操作"，保持原来的 409 互斥。
 */
export const OAUTH_FLOW_REPLACE_AFTER_MS = 60_000

const pendingOAuthFlows = new Map<string, OAuthPendingFlow>()
const oauthCallbackServers = new Map<string, Server>()
const oauthFlowAbortControllers = new Map<string, AbortController>()
const MAX_PENDING_OAUTH_FLOWS = 256

async function loadPendingOAuthFlows(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.PENDING_OAUTH_FLOWS_PATH)
    const parsed = JSON.parse(data.toString("utf8")) as Record<
      string,
      OAuthPendingFlow
    >
    for (const [key, value] of Object.entries(parsed)) {
      if (value.expiresAt > Date.now() && value.status === "pending") {
        pendingOAuthFlows.set(key, value)
      }
    }
    logger.debug("Loaded pending OAuth flows:", pendingOAuthFlows.size)
  } catch {
    // File missing or invalid
  }
}

function flowForPersistence(flow: OAuthPendingFlow): OAuthPendingFlow {
  return {
    id: flow.id,
    provider: flow.provider,
    label: flow.label,
    status: flow.status,
    expiresAt: flow.expiresAt,
    interval: flow.interval,
    authUrl: flow.authUrl,
    verificationUri: flow.verificationUri,
    userCode: flow.userCode,
    proxyUrl: flow.proxyUrl,
    region: flow.region,
    redirectUri: flow.redirectUri,
  }
}

async function savePendingOAuthFlows(): Promise<void> {
  purgeStaleOAuthFlows()
  const serializable = Object.fromEntries(
    [...pendingOAuthFlows.entries()]
      .filter(([, flow]) => flow.status === "pending")
      .map(([id, flow]) => [id, flowForPersistence(flow)]),
  )
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  assertWritableDataPath(PATHS.PENDING_OAUTH_FLOWS_PATH)
  await fs.writeFile(
    PATHS.PENDING_OAUTH_FLOWS_PATH,
    JSON.stringify(serializable, null, 2),
    { mode: 0o600 },
  )
}

let pendingOAuthFlowSave: Promise<void> = Promise.resolve()

function scheduleOAuthFlowSave(): void {
  // Serialize snapshots so an older write cannot finish after a newer one.
  pendingOAuthFlowSave = pendingOAuthFlowSave
    .then(savePendingOAuthFlows)
    .catch((error: unknown) => {
      logger.warn("Failed to persist pending OAuth flows:", error)
    })
}

/** Wait for fire-and-forget persistence before a test removes its data dir. */
export async function flushOAuthFlowSavesForTest(): Promise<void> {
  await pendingOAuthFlowSave
}

function purgeStaleOAuthFlows(): void {
  const now = Date.now()
  for (const [flowId, flow] of pendingOAuthFlows.entries()) {
    if (flow.expiresAt <= now) {
      removeOAuthFlow(flowId)
    }
  }
}

/** 该 provider 当前活跃的 flow（pending 或 exchanging）。 */
function getActiveOAuthFlowForProvider(
  provider: OAuthFlowProvider,
): OAuthPendingFlow | undefined {
  purgeStaleOAuthFlows()
  const now = Date.now()
  for (const flow of pendingOAuthFlows.values()) {
    if (flow.provider !== provider) {
      continue
    }
    if (flow.expiresAt <= now) {
      continue
    }
    if (flow.status === "pending" || flow.status === "exchanging") {
      return flow
    }
  }
  return undefined
}

export function hasActiveOAuthFlowForProvider(
  provider: OAuthFlowProvider,
): boolean {
  return getActiveOAuthFlowForProvider(provider) !== undefined
}

/**
 * 可以安全替换掉的残留 pending flow（见 OAUTH_FLOW_REPLACE_AFTER_MS）。
 *
 * `exchanging` 永不返回——那是在兑换 token，替换会打断正在进行的登录。
 */
export function findReplaceableOAuthFlowForProvider(
  provider: OAuthFlowProvider,
): OAuthPendingFlow | undefined {
  const active = getActiveOAuthFlowForProvider(provider)
  if (!active || active.status !== "pending") {
    return undefined
  }
  if (
    active.createdAt !== undefined
    && Date.now() - active.createdAt <= OAUTH_FLOW_REPLACE_AFTER_MS
  ) {
    return undefined
  }
  return active
}

void loadPendingOAuthFlows()

export function registerOAuthFlow(flow: OAuthPendingFlow): void {
  purgeStaleOAuthFlows()
  flow.createdAt ??= Date.now()
  if (pendingOAuthFlows.size >= MAX_PENDING_OAUTH_FLOWS) {
    const oldest = pendingOAuthFlows.keys().next().value
    if (typeof oldest === "string") removeOAuthFlow(oldest)
  }
  pendingOAuthFlows.set(flow.id, flow)
  scheduleOAuthFlowSave()
}

export function bindOAuthFlowAbortSignal(flowId: string): AbortSignal {
  const existing = oauthFlowAbortControllers.get(flowId)
  if (existing) {
    existing.abort()
  }
  const controller = new AbortController()
  oauthFlowAbortControllers.set(flowId, controller)
  return controller.signal
}

export function getOAuthFlow(flowId: string): OAuthPendingFlow | undefined {
  return pendingOAuthFlows.get(flowId)
}

export function updateOAuthFlow(
  flowId: string,
  patch: Partial<OAuthPendingFlow>,
): OAuthPendingFlow | undefined {
  const existing = pendingOAuthFlows.get(flowId)
  if (!existing) {
    return undefined
  }
  const updated = { ...existing, ...patch }
  if (
    updated.status === "complete"
    || updated.status === "error"
    || updated.status === "expired"
  ) {
    updated.state = undefined
    updated.nonce = undefined
    updated.pkce = undefined
    updated.deviceCode = undefined
    updated.deviceId = undefined
    updated.tokenEndpoint = undefined
    updated.deviceExpiresIn = undefined
  }
  pendingOAuthFlows.set(flowId, updated)
  scheduleOAuthFlowSave()
  return updated
}

type OAuthExchangeClaim =
  | { kind: "claim"; flow: OAuthPendingFlow }
  | { kind: "complete"; flow: OAuthPendingFlow; accountId: string }
  | { kind: "unavailable" }

export function tryBeginOAuthExchange(flowId: string): OAuthExchangeClaim {
  const existing = pendingOAuthFlows.get(flowId)
  if (!existing) {
    return { kind: "unavailable" }
  }

  if (existing.status === "complete" && existing.accountId) {
    return {
      kind: "complete",
      flow: existing,
      accountId: existing.accountId,
    }
  }

  if (existing.status !== "pending") {
    return { kind: "unavailable" }
  }

  const claimed: OAuthPendingFlow = { ...existing, status: "exchanging" }
  pendingOAuthFlows.set(flowId, claimed)
  scheduleOAuthFlowSave()
  return { kind: "claim", flow: claimed }
}

export function removeOAuthFlow(flowId: string): void {
  const controller = oauthFlowAbortControllers.get(flowId)
  if (controller) {
    controller.abort()
    oauthFlowAbortControllers.delete(flowId)
  }
  pendingOAuthFlows.delete(flowId)
  stopOAuthCallbackServer(flowId)
}

interface OAuthCallbackResult {
  code: string
  state: string
}

interface OAuthCallbackServerOptions {
  flowId: string
  port: number
  hostname?: string
  callbackPath: string
  successPath?: string
  expectedState: string
  timeoutMs?: number
  providerLabel: string
  /**
   * How the provider delivers the authorization result:
   * - "query" (default): a GET redirect carrying `code`/`state` in the query.
   * - "post": the provider's page POSTs the result (JSON or form) to the
   *   callback, e.g. Command Code Studio posts the minted API key.
   */
  mode?: "query" | "post"
  /** Allowed `Origin`s for a POST callback (browser CORS + preflight). */
  corsOrigins?: Array<string>
  /** Match the callback on any path (Zed comes back on whatever path). */
  anyPath?: boolean
  /** Query param names carrying the result (default code/state). */
  queryParams?: { code: string; state: string }
  /** Where to send the browser after a successful callback (default /success). */
  successRedirect?: string
  /** Skip the `state` match (Zed sends its own `user_id`, not our state). */
  skipStateCheck?: boolean
  /** Resolve `code` as `<state>\u0000<code>` so the caller gets both values. */
  combineIntoCode?: boolean
}

/** CORS headers for a POST callback: only the provider's own origins. */
function oauthCorsHeaders(
  request: Request,
  origins: Array<string>,
): Record<string, string> {
  const requestOrigin = request.headers.get("origin") ?? ""
  const allow =
    origins.includes(requestOrigin) ? requestOrigin : (origins[0] ?? "*")
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  }
  if (
    request.headers.get("access-control-request-private-network") === "true"
  ) {
    headers["Access-Control-Allow-Private-Network"] = "true"
  }
  return headers
}

/** Read a POST callback body (JSON object or urlencoded form) as strings. */
function readCallbackFields(
  raw: string,
  contentType: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null) continue
        out[key] = typeof value === "string" ? value : String(value)
      }
    } catch {
      // fall through: empty
    }
    return out
  }
  for (const [key, value] of new URLSearchParams(raw).entries()) {
    out[key] = value
  }
  return out
}

export async function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions,
): Promise<OAuthCallbackResult> {
  const {
    flowId,
    port,
    hostname = "127.0.0.1",
    callbackPath,
    successPath = "/success",
    expectedState,
    timeoutMs = 5 * 60 * 1000,
    providerLabel,
    mode = "query",
    corsOrigins = [],
    anyPath = false,
    queryParams = { code: "code", state: "state" },
    successRedirect,
    skipStateCheck = false,
    combineIntoCode = false,
  } = options

  stopOAuthCallbackServer(flowId)

  return await new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopOAuthCallbackServer(flowId)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${providerLabel} OAuth callback timed out`))
      })
    }, timeoutMs)

    const server = Bun.serve({
      port,
      hostname,
      async fetch(request) {
        const url = new URL(request.url)
        if (anyPath || url.pathname === callbackPath) {
          const cors = oauthCorsHeaders(request, corsOrigins)

          if (mode === "post") {
            if (request.method === "OPTIONS") {
              return new Response(null, { status: 204, headers: cors })
            }
            if (request.method !== "POST") {
              return new Response("Method not allowed", {
                status: 405,
                headers: cors,
              })
            }
            const raw = await request.text()
            const fields = readCallbackFields(
              raw,
              request.headers.get("content-type") ?? "",
            )
            const postedCode = fields.apiKey || fields.code || ""
            const postedState = fields.state ?? ""
            const postedError = fields.error ?? ""
            const json = (body: unknown, status: number) =>
              new Response(JSON.stringify(body), {
                status,
                headers: { ...cors, "content-type": "application/json" },
              })
            if (postedError) {
              const message = fields.error_description || postedError
              finish(() => {
                reject(new Error(`${providerLabel} OAuth error: ${message}`))
              })
              return json({ success: false, error: message }, 400)
            }
            if (!postedCode || !postedState) {
              finish(() => {
                reject(
                  new Error(
                    `${providerLabel} OAuth callback missing code or state`,
                  ),
                )
              })
              return json(
                { success: false, error: "Missing code or state" },
                400,
              )
            }
            if (postedState !== expectedState) {
              finish(() => {
                reject(new Error(`${providerLabel} OAuth state mismatch`))
              })
              return json({ success: false, error: "State mismatch" }, 403)
            }
            finish(() => {
              resolve({ code: postedCode, state: postedState })
            })
            return json({ success: true }, 200)
          }

          const code = url.searchParams.get(queryParams.code)
          const state = url.searchParams.get(queryParams.state)
          const error = url.searchParams.get("error")

          if (error) {
            finish(() => {
              reject(new Error(`${providerLabel} OAuth error: ${error}`))
            })
            return new Response(`OAuth error: ${error}`, { status: 400 })
          }

          if (!code || !state) {
            finish(() => {
              reject(
                new Error(
                  `${providerLabel} OAuth callback missing code or state`,
                ),
              )
            })
            return new Response("Missing code or state", { status: 400 })
          }

          if (!skipStateCheck && state !== expectedState) {
            finish(() => {
              reject(new Error(`${providerLabel} OAuth state mismatch`))
            })
            return new Response("State mismatch", { status: 400 })
          }

          finish(() => {
            resolve({
              code: combineIntoCode ? `${state}\u0000${code}` : code,
              state,
            })
          })
          const redirectHost = hostname === "127.0.0.1" ? "localhost" : hostname
          return Response.redirect(
            successRedirect ?? `http://${redirectHost}:${port}${successPath}`,
            302,
          )
        }

        if (url.pathname === successPath) {
          return new Response(
            "<html><body><h1>Authentication successful</h1><p>You can close this window.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          )
        }

        return new Response("Not found", { status: 404 })
      },
    })

    oauthCallbackServers.set(flowId, server)
  })
}

export function stopOAuthCallbackServer(flowId: string): void {
  const server = oauthCallbackServers.get(flowId)
  if (server) {
    void server.stop()
    oauthCallbackServers.delete(flowId)
  }
}

interface OAuthCallbackConfig {
  port: number
  hostname?: string
  callbackPath: string
  providerLabel: string
  /** "post" when the provider's page POSTs the result (see the server). */
  mode?: "query" | "post"
  /** Allowed origins for a POST callback. */
  corsOrigins?: Array<string>
  /** Match the callback on any path (Zed comes back on whatever path). */
  anyPath?: boolean
  /** Query param names carrying the result (default code/state). */
  queryParams?: { code: string; state: string }
  /** Where to send the browser after a successful callback. */
  successRedirect?: string
  /** Skip the `state` match (Zed sends its own `user_id`). */
  skipStateCheck?: boolean
  /** Resolve `code` as `<state>\u0000<code>` so the caller gets both values. */
  combineIntoCode?: boolean
}

export const OAUTH_CALLBACK_CONFIGS: Partial<
  Record<OAuthFlowProvider, OAuthCallbackConfig>
> = {
  claude: { port: 54545, callbackPath: "/callback", providerLabel: "Claude" },
  codex: {
    port: 1455,
    callbackPath: "/auth/callback",
    providerLabel: "Codex",
  },
  xai: {
    port: 56121,
    hostname: "127.0.0.1",
    callbackPath: "/callback",
    providerLabel: "xAI",
  },
  antigravity: {
    port: 51121,
    hostname: "localhost",
    callbackPath: "/oauth-callback",
    providerLabel: "Antigravity",
  },
  // Devin's authorization page only accepts a loopback redirect
  // (`http://127.0.0.1:<port>/callback`), so the callback server has to listen
  // on the same port the CLI identity advertises — see
  // `WINDSURF_REDIRECT_URI`. Without this entry the flow type
  // (`pkce-callback`) has no server to start and every non-manual login dies
  // with "Provider \"windsurf\" does not use a callback server".
  windsurf: {
    port: WINDSURF_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: WINDSURF_CALLBACK_PATH,
    providerLabel: "Devin",
  },
  lobsterai: {
    port: LOBSTERAI_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: LOBSTERAI_CALLBACK_PATH,
    providerLabel: "LobsterAI",
  },
  // Command Code Studio POSTs the minted API key (JSON or form) to the
  // loopback callback instead of redirecting with a code, so this one is a
  // POST callback with CORS for the Studio origin.
  "commandcode-plan": {
    port: COMMANDCODE_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: COMMANDCODE_CALLBACK_PATH,
    providerLabel: "Command Code",
    mode: "post",
    corsOrigins: ["https://commandcode.ai", "https://staging.commandcode.ai"],
  },
  // Zed comes back on whatever path, with user_id + access_token in the
  // query (the token encrypted to the key magpie made); it then sends the
  // browser on to its own "succeeded" page.
  zed: {
    port: ZED_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: "/",
    providerLabel: "Zed",
    anyPath: true,
    queryParams: { code: "access_token", state: "user_id" },
    successRedirect: ZED_SIGNIN_SUCCEEDED_URL,
    skipStateCheck: true,
    combineIntoCode: true,
  },
  // DimAgent 用固定 public client 的固定回调 http://localhost:54321/auth/callback。
  dimagent: {
    port: DIMAGENT_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: DIMAGENT_CALLBACK_PATH,
    providerLabel: "DimAgent",
  },
  // Gemini CLI 的 Google OAuth 回到 127.0.0.1:59656/oauth2callback。
  gemini: {
    port: GEMINI_CALLBACK_PORT,
    hostname: "127.0.0.1",
    callbackPath: GEMINI_CALLBACK_PATH,
    providerLabel: "Gemini CLI",
  },
}

export async function startProviderCallbackServer(
  provider: OAuthFlowProvider,
  flowId: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackResult> {
  const config = OAUTH_CALLBACK_CONFIGS[provider]
  if (!config) {
    throw new Error(`Provider "${provider}" does not use a callback server`)
  }
  return startOAuthCallbackServer({
    flowId,
    port: config.port,
    hostname: config.hostname,
    callbackPath: config.callbackPath,
    expectedState,
    timeoutMs,
    providerLabel: config.providerLabel,
    mode: config.mode,
    corsOrigins: config.corsOrigins,
    anyPath: config.anyPath,
    queryParams: config.queryParams,
    successRedirect: config.successRedirect,
    skipStateCheck: config.skipStateCheck,
    combineIntoCode: config.combineIntoCode,
  })
}

export function pollOAuthFlow(flowId: string): {
  status: string
  accountId?: string
  interval?: number
  error?: string
  authUrl?: string
  verificationUri?: string
  userCode?: string
} {
  const flow = pendingOAuthFlows.get(flowId)
  if (!flow) {
    return { status: "error", error: "Unknown or expired OAuth flow." }
  }

  if (flow.status === "complete") {
    return { status: "complete", accountId: flow.accountId }
  }

  if (flow.status === "exchanging") {
    return { status: "pending", interval: flow.interval }
  }

  if (flow.status === "error") {
    return { status: "error", error: flow.error ?? "OAuth flow failed" }
  }

  if (flow.status === "expired" || Date.now() > flow.expiresAt) {
    updateOAuthFlow(flowId, { status: "expired" })
    purgeStaleOAuthFlows()
    return { status: "expired" }
  }

  purgeStaleOAuthFlows()

  return {
    status: "pending",
    interval: flow.interval,
    authUrl: flow.authUrl,
    verificationUri: flow.verificationUri,
    userCode: flow.userCode,
  }
}

export function resetOAuthFlowsForTest(): void {
  for (const flowId of pendingOAuthFlows.keys()) {
    removeOAuthFlow(flowId)
  }
}
