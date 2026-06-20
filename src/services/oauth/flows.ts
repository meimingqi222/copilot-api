import type { Server } from "bun"

import consola from "consola"
import fs from "node:fs/promises"

import type { AccountProvider } from "~/lib/accounts"

import { PATHS } from "~/lib/paths"

import type { PkceCodes } from "./pkce"

export type OAuthFlowProvider =
  | "claude"
  | "kimi"
  | "codex"
  | "xai"
  | "antigravity"

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
}

const pendingOAuthFlows = new Map<string, OAuthPendingFlow>()
const oauthCallbackServers = new Map<string, Server>()
const oauthFlowAbortControllers = new Map<string, AbortController>()

export async function loadPendingOAuthFlows(): Promise<void> {
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
    consola.debug("Loaded pending OAuth flows:", pendingOAuthFlows.size)
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
    redirectUri: flow.redirectUri,
  }
}

export async function savePendingOAuthFlows(): Promise<void> {
  purgeStaleOAuthFlows()
  const serializable = Object.fromEntries(
    [...pendingOAuthFlows.entries()]
      .filter(([, flow]) => flow.status === "pending")
      .map(([id, flow]) => [id, flowForPersistence(flow)]),
  )
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(
    PATHS.PENDING_OAUTH_FLOWS_PATH,
    JSON.stringify(serializable, null, 2),
    { mode: 0o600 },
  )
}

function purgeStaleOAuthFlows(): void {
  const now = Date.now()
  for (const [flowId, flow] of pendingOAuthFlows.entries()) {
    const terminal =
      flow.status === "complete"
      || flow.status === "error"
      || flow.status === "expired"
    if (terminal && flow.expiresAt <= now) {
      removeOAuthFlow(flowId)
    }
  }
}

export function hasActiveOAuthFlowForProvider(
  provider: OAuthFlowProvider,
): boolean {
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
      return true
    }
  }
  return false
}

void loadPendingOAuthFlows()

export function registerOAuthFlow(flow: OAuthPendingFlow): void {
  pendingOAuthFlows.set(flow.id, flow)
  void savePendingOAuthFlows()
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

export function getOAuthFlowAbortSignal(
  flowId: string,
): AbortSignal | undefined {
  return oauthFlowAbortControllers.get(flowId)?.signal
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
  }
  pendingOAuthFlows.set(flowId, updated)
  void savePendingOAuthFlows()
  return updated
}

export type OAuthExchangeClaim =
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
  void savePendingOAuthFlows()
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
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === callbackPath) {
          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
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

          if (state !== expectedState) {
            finish(() => {
              reject(new Error(`${providerLabel} OAuth state mismatch`))
            })
            return new Response("State mismatch", { status: 400 })
          }

          finish(() => {
            resolve({ code, state })
          })
          const redirectHost = hostname === "127.0.0.1" ? "localhost" : hostname
          return Response.redirect(
            `http://${redirectHost}:${port}${successPath}`,
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

export function stopAllOAuthCallbackServers(): void {
  for (const flowId of oauthCallbackServers.keys()) {
    stopOAuthCallbackServer(flowId)
  }
}

export async function startClaudeCallbackServer(
  flowId: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackResult> {
  return startOAuthCallbackServer({
    flowId,
    port: 54545,
    callbackPath: "/callback",
    expectedState,
    timeoutMs,
    providerLabel: "Claude",
  })
}

export async function startCodexCallbackServer(
  flowId: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackResult> {
  return startOAuthCallbackServer({
    flowId,
    port: 1455,
    callbackPath: "/auth/callback",
    expectedState,
    timeoutMs,
    providerLabel: "Codex",
  })
}

export async function startXaiCallbackServer(
  flowId: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackResult> {
  return startOAuthCallbackServer({
    flowId,
    port: 56121,
    hostname: "127.0.0.1",
    callbackPath: "/callback",
    expectedState,
    timeoutMs,
    providerLabel: "xAI",
  })
}

export async function startAntigravityCallbackServer(
  flowId: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<OAuthCallbackResult> {
  return startOAuthCallbackServer({
    flowId,
    port: 51121,
    hostname: "localhost",
    callbackPath: "/oauth-callback",
    expectedState,
    timeoutMs,
    providerLabel: "Antigravity",
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

export function getOAuthFlowProvider(
  provider: AccountProvider,
): OAuthFlowProvider | undefined {
  if (
    provider === "claude"
    || provider === "kimi"
    || provider === "codex"
    || provider === "xai"
    || provider === "antigravity"
  ) {
    return provider
  }
  return undefined
}
