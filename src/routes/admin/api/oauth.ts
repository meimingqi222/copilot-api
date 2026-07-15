import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { OAuthAccount } from "~/lib/accounts"

import { cancelTokenRefreshTimer, saveAccounts } from "~/lib/account-store"
import { addAccount, getAccount, listAccounts } from "~/lib/accounts"
import { logger } from "~/lib/logger"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import { removeProviderConnection } from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { refreshModelsForAccount } from "~/lib/utils"
import { upgradeOAuthAccountLabelIfNeeded } from "~/services/oauth/account-label"
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
  scheduleOAuthRefreshForAccount,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { publicAccount } from "./accounts"

export const oauthApiRoutes = new Hono()

const FLOW_TIMEOUT_MS = 15 * 60 * 1000

function parseLabel(body: { label?: string }, provider: string): string {
  const trimmed = body.label?.trim()
  return trimmed || `${provider}-${listAccounts().length + 1}`
}

function parseProxyUrl(body: { proxyUrl?: string }): string | undefined {
  const trimmed = body.proxyUrl?.trim()
  return trimmed || undefined
}

function removeOAuthAccountFromState(accountId: string): void {
  if (!getAccount(accountId)) {
    return
  }

  cancelTokenRefreshTimer(accountId)
  cancelOAuthRefreshTimer(accountId)
  clearAccountRateLimitState(accountId)
  // 批次 2：通过 removeProviderConnection + 重建 state.accounts
  removeProviderConnection(accountId)
}

async function finalizeOAuthAccount(account: OAuthAccount): Promise<void> {
  upgradeOAuthAccountLabelIfNeeded(account)
  addAccount(account)
  scheduleOAuthRefreshForAccount(account)
  try {
    await refreshModelsForAccount(account)
    await saveAccounts()
    initializeProviderRegistry()
    const runtime = getProviderRuntime(account.provider)
    if (runtime.refreshQuota) {
      void runtime.refreshQuota(account).catch((error: unknown) => {
        logger.warn(`Failed to refresh quota for "${account.label}":`, error)
      })
    }
  } catch (error: unknown) {
    removeOAuthAccountFromState(account.id)
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
  const account = await strategy.exchange({
    flow: claim.flow,
    code: exchangeInput.code,
    signal: exchangeInput.signal,
  })

  await finalizeOAuthAccount(account)
  updateOAuthFlow(flowId, {
    status: "complete",
    accountId: account.id,
  })
  return account.id
}

oauthApiRoutes.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthProviderId(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }

  let body: { label?: string; proxyUrl?: string; manual?: boolean }
  try {
    body = await c.req.json()
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
    body = await c.req.json()
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
    const account = getAccount(flow.accountId)
    return c.json({
      status: "complete",
      accountId: flow.accountId,
      account: account ? publicAccount(account) : undefined,
    })
  }

  try {
    const accountId = await executeOAuthExchange(provider, flowId, { code })
    const account = getAccount(accountId)
    return c.json({
      status: "complete",
      accountId,
      account: account ? publicAccount(account) : undefined,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "OAuth flow is not available for token exchange") {
      const current = getOAuthFlow(flowId)
      if (current?.status === "complete" && current.accountId) {
        const account = getAccount(current.accountId)
        return c.json({
          status: "complete",
          accountId: current.accountId,
          account: account ? publicAccount(account) : undefined,
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
    body = await c.req.json()
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
    const account = getAccount(result.accountId)
    return c.json({
      ...result,
      account: account ? publicAccount(account) : undefined,
    })
  }

  return c.json(result)
})
