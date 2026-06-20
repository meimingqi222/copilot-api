import consola from "consola"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { OAuthAccount } from "~/lib/accounts"
import type { OAuthFetchOptions } from "~/services/oauth/fetch"

import { cancelTokenRefreshTimer, saveAccounts } from "~/lib/account-store"
import { addAccount } from "~/lib/accounts"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { refreshModelsForAccount } from "~/lib/utils"
import {
  applyAntigravityOAuthBundle,
  createAntigravityOAuthStart,
  exchangeAntigravityCodeForTokens,
} from "~/services/oauth/antigravity"
import {
  applyClaudeOAuthBundle,
  createClaudeOAuthStart,
  exchangeClaudeCodeForTokens,
} from "~/services/oauth/claude"
import {
  applyCodexOAuthBundle,
  createCodexOAuthStart,
  exchangeCodexCodeForTokens,
} from "~/services/oauth/codex"
import {
  getOAuthFlow,
  hasActiveOAuthFlowForProvider,
  pollOAuthFlow,
  registerOAuthFlow,
  startAntigravityCallbackServer,
  startClaudeCallbackServer,
  startCodexCallbackServer,
  startXaiCallbackServer,
  tryBeginOAuthExchange,
  updateOAuthFlow,
  type OAuthFlowProvider,
  type OAuthPendingFlow,
} from "~/services/oauth/flows"
import {
  applyKimiOAuthBundle,
  createKimiDeviceId,
  pollKimiDeviceAuthorization,
  startKimiDeviceFlow,
} from "~/services/oauth/kimi"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForAccount,
} from "~/services/oauth/refresh-scheduler"
import {
  applyXaiOAuthBundle,
  createXaiOAuthStart,
  discoverXaiOAuthEndpoints,
  exchangeXaiCodeForTokens,
} from "~/services/oauth/xai"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

import { publicAccount } from "./accounts"

export const oauthApiRoutes = new Hono()

const FLOW_TIMEOUT_MS = 15 * 60 * 1000
const PKCE_PROVIDERS = new Set<OAuthFlowProvider>(["claude", "codex", "xai"])
const CALLBACK_OAUTH_PROVIDERS = new Set<OAuthFlowProvider>([
  ...PKCE_PROVIDERS,
  "antigravity",
])

function isPkceOAuthProvider(value: string): value is OAuthFlowProvider {
  return PKCE_PROVIDERS.has(value as OAuthFlowProvider)
}

function isCallbackOAuthProvider(value: string): value is OAuthFlowProvider {
  return CALLBACK_OAUTH_PROVIDERS.has(value as OAuthFlowProvider)
}

function parseLabel(body: { label?: string }, provider: string): string {
  const trimmed = body.label?.trim()
  return trimmed || `${provider}-${state.accounts.length + 1}`
}

function parseProxyUrl(body: { proxyUrl?: string }): string | undefined {
  const trimmed = body.proxyUrl?.trim()
  return trimmed || undefined
}

function flowFetchOptions(
  flow: OAuthPendingFlow,
): OAuthFetchOptions | undefined {
  return flow.proxyUrl ? { proxyUrl: flow.proxyUrl } : undefined
}

function applyFlowSettingsToAccount(
  account: OAuthAccount,
  flow: OAuthPendingFlow,
): void {
  if (flow.proxyUrl) {
    account.settings = {
      ...account.settings,
      proxyUrl: flow.proxyUrl,
    }
  }
}

function createOAuthAccount(
  provider: OAuthProviderId,
  label: string,
): OAuthAccount {
  return {
    id: randomUUID(),
    label,
    provider,
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
    credentials: {},
    settings: {},
    runtimeState: {
      authStatus: "pending",
    },
  }
}

function removeOAuthAccountFromState(accountId: string): void {
  const idx = state.accounts.findIndex((item) => item.id === accountId)
  if (idx === -1) {
    return
  }

  cancelTokenRefreshTimer(accountId)
  cancelOAuthRefreshTimer(accountId)
  clearAccountRateLimitState(accountId)
  state.accounts.splice(idx, 1)

  if (idx < state.activeAccountIndex) {
    state.activeAccountIndex = Math.max(0, state.activeAccountIndex - 1)
  } else if (idx === state.activeAccountIndex) {
    state.activeAccountIndex = Math.min(
      idx,
      Math.max(0, state.accounts.length - 1),
    )
  }
}

async function finalizeOAuthAccount(account: OAuthAccount): Promise<void> {
  addAccount(account)
  scheduleOAuthRefreshForAccount(account)
  try {
    await refreshModelsForAccount(account)
    await saveAccounts()
    initializeProviderRegistry()
    const runtime = getProviderRuntime(account.provider)
    if (runtime.refreshQuota) {
      void runtime.refreshQuota(account).catch((error: unknown) => {
        consola.warn(`Failed to refresh quota for "${account.label}":`, error)
      })
    }
  } catch (error: unknown) {
    removeOAuthAccountFromState(account.id)
    throw error
  }
}

async function waitForPkceCallback(
  provider: OAuthFlowProvider,
  flowId: string,
  oauthState: string,
): Promise<{ code: string }> {
  switch (provider) {
    case "claude": {
      return startClaudeCallbackServer(flowId, oauthState)
    }
    case "codex": {
      return startCodexCallbackServer(flowId, oauthState)
    }
    case "xai": {
      return startXaiCallbackServer(flowId, oauthState)
    }
    default: {
      throw new Error(`Provider "${provider}" does not use PKCE callback`)
    }
  }
}

async function exchangePkceProviderTokens(
  provider: OAuthFlowProvider,
  code: string,
  flowId: string,
): Promise<string> {
  const claim = tryBeginOAuthExchange(flowId)
  if (claim.kind === "complete") {
    return claim.accountId
  }
  if (claim.kind !== "claim") {
    throw new Error("OAuth flow is not available for token exchange")
  }

  const flow = claim.flow
  if (!flow.pkce) {
    throw new Error(`${provider} OAuth flow is missing PKCE codes`)
  }

  const account = createOAuthAccount(provider, flow.label)
  applyFlowSettingsToAccount(account, flow)
  const fetchOptions = flowFetchOptions(flow)

  switch (provider) {
    case "claude": {
      if (!flow.state) {
        throw new Error("Claude OAuth flow is missing state")
      }
      const bundle = await exchangeClaudeCodeForTokens(
        code,
        flow.state,
        flow.pkce,
        fetchOptions,
      )
      applyClaudeOAuthBundle(account, bundle)
      break
    }
    case "codex": {
      const bundle = await exchangeCodexCodeForTokens(
        code,
        flow.pkce,
        fetchOptions,
      )
      applyCodexOAuthBundle(account, bundle)
      break
    }
    case "xai": {
      if (!flow.tokenEndpoint) {
        throw new Error("xAI OAuth flow is missing token endpoint")
      }
      const bundle = await exchangeXaiCodeForTokens(
        code,
        flow.pkce,
        flow.tokenEndpoint,
        fetchOptions,
      )
      applyXaiOAuthBundle(account, bundle)
      break
    }
    default: {
      throw new Error(`Unsupported PKCE provider: ${provider}`)
    }
  }

  await finalizeOAuthAccount(account)
  updateOAuthFlow(flowId, {
    status: "complete",
    accountId: account.id,
  })
  return account.id
}

async function exchangeAntigravityProviderTokens(
  code: string,
  flowId: string,
): Promise<string> {
  const claim = tryBeginOAuthExchange(flowId)
  if (claim.kind === "complete") {
    return claim.accountId
  }
  if (claim.kind !== "claim") {
    throw new Error("OAuth flow is not available for token exchange")
  }

  const flow = claim.flow
  if (!flow.redirectUri) {
    throw new Error("Antigravity OAuth flow is missing redirect URI")
  }

  const account = createOAuthAccount("antigravity", flow.label)
  applyFlowSettingsToAccount(account, flow)
  const bundle = await exchangeAntigravityCodeForTokens(
    code,
    flow.redirectUri,
    flowFetchOptions(flow),
  )
  applyAntigravityOAuthBundle(account, bundle)
  await finalizeOAuthAccount(account)
  updateOAuthFlow(flowId, {
    status: "complete",
    accountId: account.id,
  })
  return account.id
}

async function exchangeKimiProviderTokens(
  flowId: string,
  deviceCode: Parameters<typeof pollKimiDeviceAuthorization>[0],
  deviceId: string,
  label: string,
): Promise<string> {
  const claim = tryBeginOAuthExchange(flowId)
  if (claim.kind === "complete") {
    return claim.accountId
  }
  if (claim.kind !== "claim") {
    throw new Error("OAuth flow is not available for token exchange")
  }

  const flow = getOAuthFlow(flowId)
  const fetchOptions = flow ? flowFetchOptions(flow) : undefined
  const bundle = await pollKimiDeviceAuthorization(
    deviceCode,
    deviceId,
    fetchOptions,
  )
  const account = createOAuthAccount("kimi", label)
  if (flow) {
    applyFlowSettingsToAccount(account, flow)
  }
  applyKimiOAuthBundle(account, bundle)
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

  let body: { label?: string; proxyUrl?: string }
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

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
  const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined

  if (provider === "kimi") {
    const deviceId = createKimiDeviceId()
    const deviceCode = await startKimiDeviceFlow(deviceId, loginFetchOptions)
    const verificationUri =
      deviceCode.verification_uri_complete || deviceCode.verification_uri || ""

    registerOAuthFlow({
      id: flowId,
      provider: "kimi",
      label,
      status: "pending",
      expiresAt,
      verificationUri,
      userCode: deviceCode.user_code,
      interval: deviceCode.interval ?? 5,
      deviceCode: deviceCode.device_code,
      deviceId,
      proxyUrl,
    })

    void (async () => {
      try {
        await exchangeKimiProviderTokens(flowId, deviceCode, deviceId, label)
      } catch (error: unknown) {
        updateOAuthFlow(flowId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()

    return c.json({
      flowId,
      status: "pending_auth",
      verificationUri,
      userCode: deviceCode.user_code,
      expiresIn: deviceCode.expires_in ?? Math.floor(FLOW_TIMEOUT_MS / 1000),
      interval: deviceCode.interval ?? 5,
    })
  }

  if (provider === "antigravity") {
    const start = createAntigravityOAuthStart()
    registerOAuthFlow({
      id: flowId,
      provider: "antigravity",
      label,
      status: "pending",
      expiresAt,
      authUrl: start.authUrl,
      state: start.state,
      redirectUri: start.redirectUri,
      proxyUrl,
    })

    void (async () => {
      try {
        const callback = await startAntigravityCallbackServer(
          flowId,
          start.state,
        )
        if (!getOAuthFlow(flowId)) {
          throw new Error("OAuth flow disappeared before token exchange")
        }
        await exchangeAntigravityProviderTokens(callback.code, flowId)
      } catch (error: unknown) {
        updateOAuthFlow(flowId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()

    return c.json({
      flowId,
      status: "pending_auth",
      authUrl: start.authUrl,
      expiresIn: Math.floor(FLOW_TIMEOUT_MS / 1000),
    })
  }

  if (!isPkceOAuthProvider(provider)) {
    return c.json(
      { error: `OAuth login not implemented for ${String(provider)}` },
      501,
    )
  }

  let authUrl = ""
  let oauthState = ""
  let pkce: OAuthPendingFlow["pkce"]
  let tokenEndpoint: string | undefined
  let nonce: string | undefined

  switch (provider) {
    case "claude": {
      const start = createClaudeOAuthStart()
      authUrl = start.authUrl
      oauthState = start.state
      pkce = start.pkce

      break
    }
    case "codex": {
      const start = createCodexOAuthStart()
      authUrl = start.authUrl
      oauthState = start.state
      pkce = start.pkce

      break
    }
    case "xai": {
      const discovery = await discoverXaiOAuthEndpoints(loginFetchOptions)
      const start = createXaiOAuthStart(discovery)
      authUrl = start.authUrl
      oauthState = start.state
      pkce = start.pkce
      tokenEndpoint = start.tokenEndpoint
      nonce = start.nonce

      break
    }
    // No default
  }

  registerOAuthFlow({
    id: flowId,
    provider,
    label,
    status: "pending",
    expiresAt,
    authUrl,
    state: oauthState,
    pkce,
    tokenEndpoint,
    nonce,
    proxyUrl,
  })

  void (async () => {
    try {
      const callback = await waitForPkceCallback(provider, flowId, oauthState)
      if (!getOAuthFlow(flowId)) {
        throw new Error("OAuth flow disappeared before token exchange")
      }
      await exchangePkceProviderTokens(provider, callback.code, flowId)
    } catch (error: unknown) {
      updateOAuthFlow(flowId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })()

  return c.json({
    flowId,
    status: "pending_auth",
    authUrl,
    expiresIn: Math.floor(FLOW_TIMEOUT_MS / 1000),
  })
})

oauthApiRoutes.post("/:provider/complete", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthProviderId(provider) || !isCallbackOAuthProvider(provider)) {
    return c.json(
      {
        error:
          "Manual completion is only supported for callback-based OAuth providers.",
      },
      400,
    )
  }

  let body: { flowId?: string; code?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const flowId = body.flowId?.trim()
  const code = body.code?.trim()
  if (!flowId || !code) {
    return c.json({ error: "flowId and code are required." }, 400)
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
    const account = state.accounts.find((item) => item.id === flow.accountId)
    return c.json({
      status: "complete",
      accountId: flow.accountId,
      account: account ? publicAccount(account) : undefined,
    })
  }

  try {
    const accountId = await (provider === "antigravity" ?
      exchangeAntigravityProviderTokens(code, flowId)
    : exchangePkceProviderTokens(provider, code, flowId))
    const account = state.accounts.find((item) => item.id === accountId)
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
        const account = state.accounts.find(
          (item) => item.id === current.accountId,
        )
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
    const account = state.accounts.find((item) => item.id === result.accountId)
    return c.json({
      ...result,
      account: account ? publicAccount(account) : undefined,
    })
  }

  return c.json(result)
})
