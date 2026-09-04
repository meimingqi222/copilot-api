import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { cancelTokenRefreshTimer, saveAccounts } from "~/lib/account-store"
import { logger } from "~/lib/logger"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import {
  getProviderConnection,
  isAccountManagedConnection,
  listAccountManagedConnections,
  providerFromProtocol,
  removeProviderConnection,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { upgradeOAuthConnectionLabelIfNeeded } from "~/services/oauth/account-label"
import { parseOAuthAuthorizationCode } from "~/services/oauth/callback-input"
import {
  bindOAuthFlowAbortSignal,
  getOAuthFlow,
  hasActiveOAuthFlowForProvider,
  pollOAuthFlow,
  registerOAuthFlow,
  removeOAuthFlow,
  startProviderCallbackServer,
  tryBeginOAuthExchange,
  updateOAuthFlow,
} from "~/services/oauth/flows"
import {
  CALLBACK_OAUTH_PROVIDERS,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForConnection,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { publicAccountFromConnection } from "./account-views"

export const oauthApiRoutes = new Hono()

const FLOW_TIMEOUT_MS = 15 * 60 * 1000

function parseLabel(body: { label?: string }, provider: string): string {
  const trimmed = body.label?.trim()
  // 使用 connection 原生列表生成默认 label(替代 listAccounts().length)
  return trimmed || `${provider}-${listAccountManagedConnections().length + 1}`
}

function parseProxyUrl(body: { proxyUrl?: string }): string | undefined {
  const trimmed = body.proxyUrl?.trim()
  return trimmed || undefined
}

function removeOAuthAccountFromState(accountId: string): void {
  // 使用 connection 原生访问器检查账号是否存在(替代 getAccount())
  const conn = getProviderConnection(accountId)
  if (!conn || !isAccountManagedConnection(conn)) {
    return
  }

  cancelTokenRefreshTimer(accountId)
  cancelOAuthRefreshTimer(accountId)
  clearAccountRateLimitState(accountId)
  // 批次 2：通过 removeProviderConnection + 重建 state.accounts
  removeProviderConnection(accountId)
}

/**
 * 通过 connection 原生访问器获取 publicAccount 视图(替代 getAccount + publicAccount)。
 * 仅对 account-managed connection 返回视图,否则返回 undefined。
 */
function publicAccountForId(accountId: string) {
  const conn = getProviderConnection(accountId)
  if (!conn || !isAccountManagedConnection(conn)) return undefined
  return publicAccountFromConnection(conn)
}

/**
 * Phase 3:connection 原生版本的 finalizeOAuthAccount。
 * connection 已由 strategy.exchange 创建并 upsert,此处只做后续初始化。
 * Phase 5:直接在 connection 上做 label upgrade,不再经由 getAccount 派生 Account 快照。
 */
async function finalizeOAuthConnection(
  conn: ProviderConnection,
): Promise<void> {
  // 直接在 connection 上做 label upgrade
  upgradeOAuthConnectionLabelIfNeeded(conn)
  scheduleOAuthRefreshForConnection(conn)
  try {
    await refreshModelsForConnection(conn)
    await saveAccounts()
    initializeProviderRegistry()
    const provider = providerFromProtocol(conn.protocol)
    if (!provider) return
    const runtime = getProviderRuntime(provider)
    if (runtime.refreshQuota) {
      void runtime.refreshQuota(conn).catch((error: unknown) => {
        logger.warn(`Failed to refresh quota for "${conn.name}":`, error)
      })
    }
  } catch (error: unknown) {
    removeOAuthAccountFromState(conn.id)
    throw error
  }
}

/**
 * Common exchange wrapper: claims the flow, delegates to the provider
 * strategy, finalizes the account, and marks the flow complete.
 */
async function executeOAuthExchange(
  provider: OAuthProviderId,
  flowId: string,
  exchangeInput: { code?: string; signal?: AbortSignal },
): Promise<string> {
  const claim = tryBeginOAuthExchange(flowId)
  if (claim.kind === "complete") {
    return claim.accountId
  }
  if (claim.kind !== "claim") {
    throw new Error("OAuth flow is not available for token exchange")
  }

  const strategy = OAUTH_PROVIDER_STRATEGIES[provider]
  const conn = await strategy.exchange({
    flow: claim.flow,
    code: exchangeInput.code,
    signal: exchangeInput.signal,
  })

  await finalizeOAuthConnection(conn)
  updateOAuthFlow(flowId, {
    status: "complete",
    accountId: conn.id,
  })
  return conn.id
}

oauthApiRoutes.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthProviderId(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }

  let body: { label?: string; proxyUrl?: string; manual?: boolean }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    body = {}
  }

  const manualCompletion = body.manual === true

  if (hasActiveOAuthFlowForProvider(provider)) {
    return c.json(
      { error: `An OAuth flow for ${provider} is already in progress.` },
      409,
    )
  }

  const label = parseLabel(body, provider)
  const proxyUrl = parseProxyUrl(body)
  const flowId = randomUUID()
  const expiresAt = Date.now() + FLOW_TIMEOUT_MS

  const strategy = OAUTH_PROVIDER_STRATEGIES[provider]
  const start = await strategy.start({ proxyUrl })

  registerOAuthFlow({
    id: flowId,
    provider,
    label,
    status: "pending",
    expiresAt,
    authUrl: start.authUrl,
    state: start.state,
    pkce: start.pkce,
    tokenEndpoint: start.tokenEndpoint,
    nonce: start.nonce,
    redirectUri: start.redirectUri,
    verificationUri: start.verificationUri,
    userCode: start.userCode,
    deviceCode: start.deviceCode,
    deviceId: start.deviceId,
    interval: start.interval,
    deviceExpiresIn: start.deviceExpiresIn,
    proxyUrl,
  })

  if (strategy.flowType === "device") {
    const abortSignal = bindOAuthFlowAbortSignal(flowId)
    void (async () => {
      try {
        await executeOAuthExchange(provider, flowId, { signal: abortSignal })
      } catch (error: unknown) {
        if (abortSignal.aborted) {
          return
        }
        updateOAuthFlow(flowId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  } else if (!manualCompletion) {
    if (!start.state) {
      return c.json(
        { error: `${provider} OAuth start did not produce a state value` },
        500,
      )
    }
    const expectedState = start.state
    void (async () => {
      try {
        const callback = await startProviderCallbackServer(
          provider,
          flowId,
          expectedState,
        )
        if (!getOAuthFlow(flowId)) {
          throw new Error("OAuth flow disappeared before token exchange")
        }
        await executeOAuthExchange(provider, flowId, { code: callback.code })
      } catch (error: unknown) {
        updateOAuthFlow(flowId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  const response: Record<string, unknown> = {
    flowId,
    status: "pending_auth",
    expiresIn: start.responseExpiresIn ?? Math.floor(FLOW_TIMEOUT_MS / 1000),
  }
  // manualCompletion is only meaningful for callback-based providers
  // (the original per-provider branches omitted it for kimi's device
  // flow). Keep the response shape unchanged per G1.
  if (strategy.flowType !== "device") {
    response.manualCompletion = manualCompletion
  }
  if (start.authUrl) {
    response.authUrl = start.authUrl
  }
  if (start.verificationUri) {
    response.verificationUri = start.verificationUri
  }
  if (start.userCode) {
    response.userCode = start.userCode
  }
  if (start.interval) {
    response.interval = start.interval
  }
  return c.json(response)
})

oauthApiRoutes.post("/:provider/complete", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthProviderId(provider) || !CALLBACK_OAUTH_PROVIDERS.has(provider)) {
    return c.json(
      {
        error:
          "Manual completion is only supported for callback-based OAuth providers.",
      },
      400,
    )
  }

  let body: { flowId?: string; code?: string; callback?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const flowId = body.flowId?.trim()
  const callbackInput = body.callback?.trim() || body.code?.trim()
  if (!flowId || !callbackInput) {
    return c.json({ error: "flowId and code (or callback) are required." }, 400)
  }

  const code = parseOAuthAuthorizationCode(callbackInput)
  if (!code) {
    return c.json(
      { error: "Could not parse authorization code from callback input." },
      400,
    )
  }

  const flow = getOAuthFlow(flowId)
  if (!flow || flow.provider !== provider) {
    return c.json({ error: `Unknown ${provider} OAuth flow.` }, 404)
  }

  if (flow.status === "error" || flow.status === "expired") {
    return c.json({ error: flow.error ?? `OAuth flow is ${flow.status}` }, 400)
  }

  if (flow.status === "exchanging") {
    return c.json({ error: "OAuth exchange already in progress" }, 409)
  }

  if (flow.status === "complete" && flow.accountId) {
    // 使用 connection 原生访问器获取账号视图(替代 getAccount + publicAccount)
    const account = publicAccountForId(flow.accountId)
    return c.json({
      status: "complete",
      accountId: flow.accountId,
      account,
    })
  }

  try {
    const accountId = await executeOAuthExchange(provider, flowId, { code })
    const account = publicAccountForId(accountId)
    return c.json({
      status: "complete",
      accountId,
      account,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "OAuth flow is not available for token exchange") {
      const current = getOAuthFlow(flowId)
      if (current?.status === "complete" && current.accountId) {
        const account = publicAccountForId(current.accountId)
        return c.json({
          status: "complete",
          accountId: current.accountId,
          account,
        })
      }
      if (current?.status === "exchanging") {
        return c.json({ error: "OAuth exchange already in progress" }, 409)
      }
      return c.json({ error: message }, 400)
    }

    updateOAuthFlow(flowId, {
      status: "error",
      error: message,
    })
    return c.json({ error: message }, 502)
  }
})

oauthApiRoutes.post("/:provider/cancel", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthProviderId(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }

  let body: { flowId?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const flowId = body.flowId?.trim()
  if (!flowId) {
    return c.json({ error: "flowId is required." }, 400)
  }

  const flow = getOAuthFlow(flowId)
  if (!flow || flow.provider !== provider) {
    return c.json({ error: `Unknown ${provider} OAuth flow.` }, 404)
  }

  if (flow.status === "complete") {
    return c.json({ status: "complete", accountId: flow.accountId })
  }

  removeOAuthFlow(flowId)
  return c.json({ status: "cancelled" })
})

oauthApiRoutes.get("/:provider/poll/:flowId", (c) => {
  const provider = c.req.param("provider")
  const flowId = c.req.param("flowId")

  if (!isOAuthProviderId(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }

  const flow = getOAuthFlow(flowId)
  if (!flow || flow.provider !== provider) {
    return c.json({ error: `Unknown ${provider} OAuth flow.` }, 404)
  }

  const result = pollOAuthFlow(flowId)
  if (result.status === "complete" && result.accountId) {
    // 使用 connection 原生访问器获取账号视图(替代 getAccount + publicAccount)
    const account = publicAccountForId(result.accountId)
    return c.json({
      ...result,
      account,
    })
  }

  return c.json(result)
})
