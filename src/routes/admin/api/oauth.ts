import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import {
  getConnectionProvider,
  getMutableProviderConnection,
  getProviderConnection,
  isAccountManagedConnection,
  listAccountManagedConnections,
  persistProviderConnections,
  removeProviderConnection,
  setConnectionAuthStatus,
  setConnectionCooldownUntil,
  setConnectionRateLimitInfo,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { cancelConnectionTokenRefresh } from "~/services/copilot/token-refresh"
import {
  followConnectionIdentityOnReauth,
  upgradeOAuthConnectionLabelIfNeeded,
} from "~/services/oauth/account-label"
import {
  parseOAuthAuthorizationCode,
  parseProviderCallbackInput,
} from "~/services/oauth/callback-input"
import {
  connectionOAuthIdentity,
  findConnectionByOAuthIdentity,
} from "~/services/oauth/identity"
import { lobsteraiCallbackStateMatches } from "~/services/oauth/lobsterai"
import {
  bindOAuthFlowAbortSignal,
  findReplaceableOAuthFlowForProvider,
  getOAuthFlow,
  hasActiveOAuthFlowForProvider,
  pollOAuthFlow,
  registerOAuthFlow,
  removeOAuthFlow,
  startProviderCallbackServer,
  stopOAuthCallbackServer,
  tryBeginOAuthExchange,
  updateOAuthFlow,
} from "~/services/oauth/flows"
import {
  getOAuthStrategy,
  isCallbackOAuthCapableProvider,
  isOAuthCapableProvider,
} from "~/services/oauth/provider-strategies"
import {
  cancelOAuthRefreshTimer,
  scheduleOAuthRefreshForConnection,
} from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
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

  cancelConnectionTokenRefresh(accountId)
  cancelOAuthRefreshTimer(accountId)
  clearAccountRateLimitState(accountId)
  // connection 是唯一真相源：直接移除，不再维护 state.accounts 镜像
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
 * strategy.exchange 返回未注册的连接，宿主在此统一注册与初始化。
 * Phase 5:直接在 connection 上做 label upgrade,不再经由 getAccount 派生 Account 快照。
 *
 * 原地重认证（flow.reauthAccountId）：exchange 产物是全新的临时 connection，
 * 此处把新 token bundle 回填到目标 connection（保留 id/label/用量统计），
 * 再丢弃临时 connection。
 */
async function finalizeOAuthConnection(
  conn: ProviderConnection,
  flow?: { reauthAccountId?: string },
): Promise<ProviderConnection> {
  // 原地重认证：把临时 connection 上的新凭据回填到目标 connection。
  // 目标保留 id/name/priority/models/用量统计；仅凭据与 quota/auth 状态更新。
  //
  // A fresh sign-in for an account we already have is a re-authentication, not
  // a second connection: two copies of one rotating refresh token would each
  // refresh on their own and invalidate the other. Match on the account's
  // identity (oauthAccountId, else email) — never the just-created connection.
  const identityMatch =
    flow?.reauthAccountId ? undefined : (
      findConnectionByOAuthIdentity(
        getConnectionProvider(conn),
        connectionOAuthIdentity(conn),
      )
    )
  const reauthTarget =
    flow?.reauthAccountId ? getMutableProviderConnection(flow.reauthAccountId)
    : identityMatch && identityMatch.id !== conn.id ? identityMatch
    : undefined
  const finalized = reauthTarget ?? conn
  if (reauthTarget) {
    applyReauthBundle(reauthTarget, conn)
    // 身份回填后，让推断出来的名称跟上新身份：判重会把新 token 并进老连接
    //（避免两份 refresh token 互相作废），但老连接的 name 还是旧身份——
    // 不跟着改，界面看起来就像新账号没有添加成功。自定义名称不受影响。
    followConnectionIdentityOnReauth(reauthTarget)
    removeProviderConnection(conn.id)
  } else {
    upsertProviderConnection(conn)
  }
  // 直接在 connection 上做 label upgrade
  upgradeOAuthConnectionLabelIfNeeded(finalized)
  scheduleOAuthRefreshForConnection(finalized)
  const finalizedProvider = getConnectionProvider(finalized)
  if (finalizedProvider) {
    await getBuiltinProviderModule(finalizedProvider)?.afterAuthentication?.(
      finalized,
    )
  }
  try {
    await refreshModelsForConnection(finalized)
    await persistProviderConnections()
    initializeProviderRegistry()
    const provider = getConnectionProvider(finalized)
    if (!provider) return finalized
    const runtime = getProviderRuntime(provider)
    if (runtime.refreshQuota) {
      void runtime.refreshQuota(finalized).catch((error: unknown) => {
        logger.warn(`Failed to refresh quota for "${finalized.name}":`, error)
      })
    }
  } catch (error: unknown) {
    // 重认证失败不删除目标账号（它只是旧凭据失效），只清理临时 connection。
    if (!reauthTarget) removeOAuthAccountFromState(conn.id)
    throw error
  }
  return finalized
}

/**
 * 把 exchange 产物（临时 connection）上的新凭据回填到目标 connection：
 * credential.value/context、credentialExtras、settings、quota 快照、
 * auth 状态。目标的 id/name/priority/enabled/models/createdAt 原样保留。
 */
function applyReauthBundle(
  target: ProviderConnection,
  fresh: ProviderConnection,
): void {
  const freshCred = fresh.credentials[0]
  const targetCred = target.credentials[0]
  if (freshCred && targetCred) {
    targetCred.value = freshCred.value
    targetCred.authMode = freshCred.authMode
    targetCred.refresherType = freshCred.refresherType
    if (freshCred.context) targetCred.context = { ...freshCred.context }
    targetCred.status = "ready"
    targetCred.lastError = undefined
    targetCred.lastErrorAt = undefined
    targetCred.updatedAt = Date.now()
    if (freshCred.quota !== undefined) targetCred.quota = freshCred.quota
    targetCred.exhaustedAt = freshCred.exhaustedAt
  }
  const freshMeta = fresh.metadata
  if (freshMeta && typeof freshMeta === "object") {
    const targetMeta = (target.metadata ??= {}) as Record<string, unknown>
    for (const key of [
      "credentialExtras",
      "cpaMetadata",
      "authStatus",
      "authError",
    ]) {
      if (key in freshMeta) {
        targetMeta[key] = (freshMeta as Record<string, unknown>)[key]
      }
    }
    const freshSettings = (freshMeta as Record<string, unknown>).settings
    if (freshSettings && typeof freshSettings === "object") {
      targetMeta.settings = {
        ...(targetMeta.settings as Record<string, unknown>),
        ...(freshSettings as Record<string, unknown>),
      }
    }
  }
  if (fresh.proxyUrl !== undefined) target.proxyUrl = fresh.proxyUrl
  // codebuddy 双模式：strategy 在临时 connection 上固化了 realm 专属
  // baseUrl / headers（同 provider 重认证，可安全回填）。
  if (fresh.baseUrl) target.baseUrl = fresh.baseUrl
  if (fresh.headers && Object.keys(fresh.headers).length > 0) {
    target.headers = { ...target.headers, ...fresh.headers }
  }
  if (fresh.modelPrefix !== undefined) target.modelPrefix = fresh.modelPrefix
  setConnectionAuthStatus(target, "ready")
  setConnectionCooldownUntil(target, undefined)
  setConnectionRateLimitInfo(target, undefined, undefined)
  target.updatedAt = Date.now()
}

/**
 * Common exchange wrapper: claims the flow, delegates to the provider
 * strategy, finalizes the account, and marks the flow complete.
 */
async function executeOAuthExchange(
  provider: string,
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

  const strategy = getOAuthStrategy(provider)
  if (!strategy) {
    throw new Error(`Unsupported OAuth provider: ${provider}`)
  }
  const conn = await strategy.exchange({
    flow: claim.flow,
    code: exchangeInput.code,
    signal: exchangeInput.signal,
  })

  const finalized = await finalizeOAuthConnection(conn, claim.flow)
  updateOAuthFlow(flowId, {
    status: "complete",
    accountId: finalized.id,
  })
  return finalized.id
}

oauthApiRoutes.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider")
  if (!isOAuthCapableProvider(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }

  let body: {
    label?: string
    proxyUrl?: string
    manual?: boolean
    reauthAccountId?: string
    /**
     * Provider 专属账号域（目前只有 MiniMax Code：`cn` / `en`）。
     * 未传时由 strategy 取默认值（MiniMax 为国内版）。
     */
    region?: string
  }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    body = {}
  }

  const manualCompletion = body.manual === true

  // 原地重认证：校验目标账号存在、是 OAuth 账号且 provider 一致。
  // 重认证 flow 与新建 flow 共享 provider 级互斥（同 provider 一次只能一个 flow）。
  let reauthAccountId: string | undefined
  const rawReauthId =
    typeof body.reauthAccountId === "string" ?
      body.reauthAccountId.trim()
    : undefined
  if (rawReauthId) {
    const target = getProviderConnection(rawReauthId)
    if (!target || !isAccountManagedConnection(target)) {
      return c.json({ error: "Reauth target account not found." }, 404)
    }
    if (getConnectionProvider(target) !== provider) {
      return c.json({ error: `Account is not a ${provider} account.` }, 400)
    }
    reauthAccountId = target.id
  }

  // 正在兑换 token 的 flow 不能被打断；残留的 pending flow（浏览器侧丢了
  // flowId、或管理端会话在重启后失效导致 poll 拿不到结果）必须可被替换，否则
  // 用户会永久卡在 "already in progress"，只能等 15 分钟 TTL 过期——重启也
  // 不解决（flow 落盘在 pending_oauth_flows.json）。
  const staleFlow = findReplaceableOAuthFlowForProvider(provider)
  if (staleFlow) {
    const ageSeconds =
      staleFlow.createdAt ?
        Math.round((Date.now() - staleFlow.createdAt) / 1000)
      : undefined
    logger.warn(
      `Replacing stale ${provider} OAuth flow ${staleFlow.id} (status=${staleFlow.status}${
        ageSeconds === undefined ? "" : `, age=${ageSeconds}s`
      }) with a new one.`,
    )
    stopOAuthCallbackServer(staleFlow.id)
    removeOAuthFlow(staleFlow.id)
  }

  if (hasActiveOAuthFlowForProvider(provider)) {
    return c.json(
      { error: `An OAuth flow for ${provider} is already in progress.` },
      409,
    )
  }

  const label = parseLabel(body, provider)
  const proxyUrl = parseProxyUrl(body)
  const region =
    typeof body.region === "string" && body.region.trim() ?
      body.region.trim()
    : undefined
  const flowId = randomUUID()
  const expiresAt = Date.now() + FLOW_TIMEOUT_MS

  const strategy = getOAuthStrategy(provider)
  if (!strategy) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400)
  }
  const start = await strategy.start({ proxyUrl, region })

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
    region,
    reauthAccountId,
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
  if (!isCallbackOAuthCapableProvider(provider)) {
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

  // 回调参数不一定是标准 code/state：先按该 provider 的回调配置解析
  // （Trae CN 的 userJwt/userInfo + combineIntoCode），再回退通用解析。
  const callbackConfig = getBuiltinProviderModule(provider)?.callback
  const code =
    ((
      callbackConfig
      && (callbackConfig.queryParams || callbackConfig.combineIntoCode)
    ) ?
      parseProviderCallbackInput(callbackInput, callbackConfig)
    : undefined) ?? parseOAuthAuthorizationCode(callbackInput)
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

  if (provider === "lobsterai") {
    if (
      !flow.state
      || !lobsteraiCallbackStateMatches(callbackInput, flow.state)
    ) {
      return c.json({ error: "LobsterAI OAuth callback state mismatch." }, 400)
    }
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
  if (!isOAuthCapableProvider(provider)) {
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

  if (!isOAuthCapableProvider(provider)) {
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
