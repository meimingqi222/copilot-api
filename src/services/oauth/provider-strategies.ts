import { randomUUID } from "node:crypto"

import type { OAuthProviderId, ProviderId } from "~/lib/provider-config"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { isOAuthProviderId, PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import {
  setConnectionSetting,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { QODER_API_HOST } from "~/services/qoder/endpoints"

import type { OAuthFetchOptions } from "./fetch"
import type { OAuthFlowProvider } from "./flows"
import type { OAuthPendingFlow } from "./flows"
import type { PkceCodes } from "./pkce"

import { generateOAuthState, generatePkceCodes } from "./pkce"

import {
  applyAntigravityOAuthBundle,
  createAntigravityOAuthStart,
  exchangeAntigravityCodeForTokens,
} from "./antigravity"
import {
  applyClaudeOAuthBundle,
  createClaudeOAuthStart,
  exchangeClaudeCodeForTokens,
  fetchClaudeBootstrapIdentity,
} from "./claude"
import {
  applyCodebuddyOAuthBundle,
  isCodebuddyOAuthProviderId,
  pollCodebuddyDeviceAuthorization,
  startCodebuddyDeviceFlow,
  type CodebuddyOAuthProviderId,
} from "./codebuddy"
import {
  applyCodexOAuthBundle,
  createCodexOAuthStart,
  exchangeCodexCodeForTokens,
} from "./codex"
import {
  applyKimiOAuthBundle,
  createKimiDeviceId,
  pollKimiDeviceAuthorization,
  startKimiDeviceFlow,
  type KimiDeviceCodeResponse,
} from "./kimi"
import {
  applyLobsteraiOAuthTokens,
  createLobsteraiOAuthStart,
  exchangeLobsteraiCode,
} from "./lobsterai"
import {
  applyMinimaxOAuthBundle,
  normalizeMinimaxRegion,
  pollMinimaxDeviceAuthorization,
  startMinimaxDeviceFlow,
  type MinimaxDeviceCodeResponse,
} from "./minimax"
import {
  applyQoderOAuthBundle,
  createQoderAuthRequest,
  exchangeQoderJobToken,
  fetchQoderUserInfo,
  pollQoderDeviceToken,
  QODER_DEVICE_FLOW_DEADLINE_MS,
  QODER_DEVICE_POLL_INTERVAL_MS,
  qoderJobTokenLifetimeMs,
} from "./qoder"
import {
  applyFactoryOAuthBundle,
  pollFactoryDeviceAuthorization,
  startFactoryDeviceFlow,
} from "./factory"
import {
  applyZcodeOAuthBundle,
  normalizeZcodeSite,
  startZcodeSignIn,
  zcodeSignInAndMint,
} from "./zcode"
import {
  applyCommandCodeOAuthBundle,
  buildCommandCodeAuthUrl,
  finalizeCommandCodeBundle,
} from "./commandcode"
import {
  applyZedOAuthBundle,
  decryptZedToken,
  fetchZedMe,
  newZedKey,
  newZedSystemId,
  ZED_CALLBACK_PORT,
  zedSignInUrl,
} from "./zed"
import {
  applyDimagentOAuthBundle,
  buildDimagentAuthUrl,
  dimagentBundle,
  exchangeDimagentCode,
  newDimagentPkce,
} from "./dimagent"
import {
  applyGeminiOAuthBundle,
  buildGeminiAuthUrl,
  exchangeGeminiCode,
  fetchGeminiUserInfo,
  geminiBundle,
  newGeminiPkce,
  resolveGeminiProject,
} from "./gemini"
import {
  applyWindsurfOAuthBundle,
  createWindsurfOAuthStart,
  exchangeWindsurfCodeForToken,
  fetchWindsurfSelfProfile,
  formatWindsurfSessionToken,
  isWindsurfSessionToken,
} from "./windsurf"
import {
  applyXaiOAuthBundle,
  createXaiOAuthStart,
  discoverXaiOAuthEndpoints,
  exchangeXaiCodeForTokens,
} from "./xai"

// ── Shared helpers (moved from oauth.ts) ────────────────────────

/**
 * Phase 3:直接创建 OAuth ProviderConnection(不经过 Account 中转)。
 * connection 的 protocol 从 PROVIDER_PROTOCOL_MAP 派生。
 * 使用同步构造 + upsertProviderConnection(不经过 withMutation/持久化),
 * 调用方负责后续 saveAccounts()/persistProviderConnections()。
 */
export function createOAuthConnection(
  provider: ProviderId,
  label: string,
): ProviderConnection {
  const protocol = PROVIDER_PROTOCOL_MAP[provider]
  const now = Date.now()
  const credential: ApiCredential = {
    id: randomUUID().slice(0, 8),
    authMode: "header",
    value: "",
    enabled: true,
    status: "ready",
    context: {},
    createdAt: now,
    updatedAt: now,
  }
  const conn: ProviderConnection = {
    id: randomUUID().slice(0, 8),
    name: label,
    protocol,
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [credential],
    models: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
  return conn
}

/**
 * Phase 3:将 flow 的 proxyUrl 等设置直接写入 connection.settings。
 */
function applyFlowSettingsToConnection(
  connection: ProviderConnection,
  flow: OAuthPendingFlow,
): void {
  if (flow.proxyUrl) {
    setConnectionSetting(connection, "proxyUrl", flow.proxyUrl)
  }
}

function flowFetchOptions(
  flow: OAuthPendingFlow,
): OAuthFetchOptions | undefined {
  return flow.proxyUrl ? { proxyUrl: flow.proxyUrl } : undefined
}

// ── Strategy interfaces ─────────────────────────────────────────

type OAuthFlowType = "pkce-callback" | "callback" | "device"

interface OAuthStartInput {
  proxyUrl?: string
  /**
   * Provider 专属账号域。目前只有 MiniMax Code 用：
   * `cn`（国内版，默认）/ `en`（国际版）。两套区域的凭证互不通用，
   * 所以必须在取设备码之前就定下来。
   */
  region?: string
}

interface OAuthStartResult {
  // Flow registration fields
  authUrl?: string
  state?: string
  pkce?: PkceCodes
  tokenEndpoint?: string
  nonce?: string
  redirectUri?: string
  verificationUri?: string
  userCode?: string
  deviceCode?: string
  deviceId?: string
  interval?: number
  // In-memory device-code expiry (seconds); bounds the polling deadline
  // for device-flow providers. Not persisted on the flow.
  deviceExpiresIn?: number
  // Override for client response expiresIn (kimi uses device code expiry)
  responseExpiresIn?: number
}

interface OAuthExchangeInput {
  flow: OAuthPendingFlow
  /** Authorization code for callback-based flows */
  code?: string
  /** Abort signal for device-flow polling */
  signal?: AbortSignal
}

interface OAuthProviderStrategy {
  readonly flowType: OAuthFlowType
  /** Start the OAuth flow (generate auth URL or device code) */
  start(input: OAuthStartInput): Promise<OAuthStartResult>
  /** Exchange authorization for tokens and return a persisted ProviderConnection */
  exchange(input: OAuthExchangeInput): Promise<ProviderConnection>
}

// ── Strategy implementations ────────────────────────────────────

const claudeStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createClaudeOAuthStart()
    return Promise.resolve({ authUrl: s.authUrl, state: s.state, pkce: s.pkce })
  },
  async exchange({ flow, code }) {
    if (!flow.state) {
      throw new Error("Claude OAuth flow is missing state")
    }
    if (!flow.pkce) {
      throw new Error("Claude OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Claude OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("claude", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeClaudeCodeForTokens(
      code,
      flow.state,
      flow.pkce,
      flowFetchOptions(flow),
    )
    // Best-effort bootstrap: recover account_uuid/email for the request
    // fingerprint (metadata.user_id.account_uuid). Login-only - identity is
    // captured once, never rewritten during refresh (oh-my-pi convention).
    if (!bundle.accountId || !bundle.email || !bundle.organizationId) {
      const identity = await fetchClaudeBootstrapIdentity(
        bundle.accessToken,
        flowFetchOptions(flow),
      )
      bundle.accountId = bundle.accountId ?? identity.accountId
      bundle.email = bundle.email ?? identity.email
      bundle.organizationId = bundle.organizationId ?? identity.organizationId
      bundle.organizationName =
        bundle.organizationName ?? identity.organizationName
    }
    applyClaudeOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const codexStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createCodexOAuthStart()
    return Promise.resolve({ authUrl: s.authUrl, state: s.state, pkce: s.pkce })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Codex OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Codex OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("codex", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeCodexCodeForTokens(
      code,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyCodexOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const xaiStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  async start({ proxyUrl }) {
    const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined
    const discovery = await discoverXaiOAuthEndpoints(loginFetchOptions)
    const s = createXaiOAuthStart(discovery)
    return {
      authUrl: s.authUrl,
      state: s.state,
      pkce: s.pkce,
      tokenEndpoint: s.tokenEndpoint,
      nonce: s.nonce,
    }
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("xAI OAuth flow is missing PKCE codes")
    }
    if (!flow.tokenEndpoint) {
      throw new Error("xAI OAuth flow is missing token endpoint")
    }
    if (!code) {
      throw new Error("xAI OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("xai", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeXaiCodeForTokens(
      code,
      flow.pkce,
      flow.tokenEndpoint,
      flowFetchOptions(flow),
    )
    applyXaiOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const antigravityStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const s = createAntigravityOAuthStart()
    return Promise.resolve({
      authUrl: s.authUrl,
      state: s.state,
      redirectUri: s.redirectUri,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.redirectUri) {
      throw new Error("Antigravity OAuth flow is missing redirect URI")
    }
    if (!code) {
      throw new Error(
        "Antigravity OAuth exchange requires an authorization code",
      )
    }
    const conn = createOAuthConnection("antigravity", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeAntigravityCodeForTokens(
      code,
      flow.redirectUri,
      flowFetchOptions(flow),
    )
    applyAntigravityOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const kimiStrategy: OAuthProviderStrategy = {
  flowType: "device",
  async start({ proxyUrl }) {
    const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined
    const deviceId = createKimiDeviceId()
    const deviceCode = await startKimiDeviceFlow(deviceId, loginFetchOptions)
    const verificationUri =
      deviceCode.verification_uri_complete || deviceCode.verification_uri || ""
    return {
      verificationUri,
      userCode: deviceCode.user_code,
      deviceCode: deviceCode.device_code,
      deviceId,
      interval: deviceCode.interval ?? 5,
      deviceExpiresIn: deviceCode.expires_in ?? undefined,
      responseExpiresIn: deviceCode.expires_in ?? undefined,
    }
  },
  async exchange({ flow, signal }) {
    if (!flow.deviceCode) {
      throw new Error("Kimi OAuth flow is missing device code")
    }
    const conn = createOAuthConnection("kimi", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const fetchOptions = flowFetchOptions(flow)
    // Reconstruct the device-code response shape expected by the poller.
    // deviceExpiresIn is kept in-memory on the flow (not persisted) so
    // the polling deadline matches the device code's actual lifetime
    // rather than always falling back to MAX_POLL_DURATION_MS.
    const deviceCodeResponse: KimiDeviceCodeResponse = {
      device_code: flow.deviceCode,
      interval: flow.interval,
      expires_in: flow.deviceExpiresIn,
    }
    const bundle = await pollKimiDeviceAuthorization(
      deviceCodeResponse,
      flow.deviceId ?? createKimiDeviceId(),
      { ...fetchOptions, signal },
    )
    applyKimiOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

/**
 * CodeBuddy 双 realm 共用同一设备流实现，仅上游 base/origin 不同。
 * flowType 为 device：start 返回 authUrl（浏览器登录），exchange 在后台
 * 轮询 token 端点直到用户完成登录，前端经 poll 接口等待完成（kimi 同款）。
 */
function createCodebuddyStrategy(
  provider: CodebuddyOAuthProviderId,
): OAuthProviderStrategy {
  return {
    flowType: "device",
    async start({ proxyUrl }) {
      const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined
      const s = await startCodebuddyDeviceFlow(provider, loginFetchOptions)
      return { authUrl: s.authUrl, state: s.state, interval: 5 }
    },
    async exchange({ flow, signal }) {
      if (!flow.state) {
        throw new Error("CodeBuddy OAuth flow is missing state")
      }
      const conn = createOAuthConnection(provider, flow.label)
      applyFlowSettingsToConnection(conn, flow)
      const bundle = await pollCodebuddyDeviceAuthorization(
        provider,
        flow.state,
        { proxyUrl: flow.proxyUrl, signal },
      )
      applyCodebuddyOAuthBundle(conn, provider, bundle)
      upsertProviderConnection(conn)
      return conn
    },
  }
}

const codebuddyStrategy = createCodebuddyStrategy("codebuddy")
const codebuddyCnStrategy = createCodebuddyStrategy("codebuddy-cn")

const windsurfStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createWindsurfOAuthStart()
    return Promise.resolve({
      authUrl: s.authUrl,
      state: s.state,
      pkce: s.pkce,
      redirectUri: s.redirectUri,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Windsurf OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Windsurf OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("windsurf", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    // Headless manual paste may carry a session token directly
    // (CPA `parseDevinManualPaste` parity): skip the code exchange.
    const pasted = code.trim()
    const sessionToken =
      isWindsurfSessionToken(pasted) ?
        formatWindsurfSessionToken(pasted)
      : formatWindsurfSessionToken(
          await exchangeWindsurfCodeForToken(
            pasted,
            flow.pkce.codeVerifier,
            flowFetchOptions(flow),
          ),
        )
    const profile = await fetchWindsurfSelfProfile(
      sessionToken,
      flowFetchOptions(flow),
    )
    applyWindsurfOAuthBundle(conn, { sessionToken, ...profile })
    upsertProviderConnection(conn)
    return conn
  },
}

/**
 * MiniMax Code：设备码 + PKCE，区域（国内版 / 国际版）在 start 时定下。
 *
 * flowType 为 device：start 返回 verificationUri/userCode，exchange 在后台
 * 轮询 token 端点直到用户在浏览器确认（kimi 同款）。
 * PKCE 的 code_verifier 挂在 flow.pkce 上——MiniMax 的 token 端点强制要求它。
 */
const minimaxStrategy: OAuthProviderStrategy = {
  flowType: "device",
  async start({ proxyUrl, region }) {
    const resolved = normalizeMinimaxRegion(region)
    const pkce = generatePkceCodes()
    const deviceCode = await startMinimaxDeviceFlow(
      resolved,
      pkce,
      proxyUrl ? { proxyUrl } : undefined,
    )
    return {
      verificationUri:
        deviceCode.verification_uri_complete ?? deviceCode.verification_uri,
      userCode: deviceCode.user_code,
      deviceCode: deviceCode.device_code,
      interval: deviceCode.interval ?? 5,
      deviceExpiresIn: deviceCode.expires_in ?? undefined,
      responseExpiresIn: deviceCode.expires_in ?? undefined,
      pkce,
    }
  },
  async exchange({ flow, signal }) {
    if (!flow.deviceCode) {
      throw new Error("MiniMax OAuth flow is missing device code")
    }
    if (!flow.pkce) {
      throw new Error("MiniMax OAuth flow is missing PKCE codes")
    }
    const region = normalizeMinimaxRegion(flow.region)
    const conn = createOAuthConnection("minimax", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    // 重构出轮询器期望的设备码响应形状（deviceExpiresIn 只存在内存里，
    // 用它约束轮询截止时间而不是永远回退到 MAX_POLL_DURATION_MS）。
    const deviceCodeResponse: MinimaxDeviceCodeResponse = {
      device_code: flow.deviceCode,
      user_code: flow.userCode ?? "",
      verification_uri: flow.verificationUri ?? "",
      interval: flow.interval,
      expires_in: flow.deviceExpiresIn,
    }
    const bundle = await pollMinimaxDeviceAuthorization(
      deviceCodeResponse,
      flow.pkce,
      region,
      { ...flowFetchOptions(flow), signal },
    )
    applyMinimaxOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

/**
 * Qoder：PKCE 设备流（非 loopback 回调、非手动粘贴）。
 *
 * 授权页把用户送到 `qoder.com/device/selectAccounts`，然后轮询
 * `openapi.qoder.sh/api/v1/deviceToken/poll` 直到确认；拿到设备 token 后再换
 * chat 用的 job token。machine_id 是账号身份，必须随 flow 一起保存（COSY 头用它），
 * 所以放在 `flow.deviceId` 上（kimi 的 deviceId 也是同一种“登录期身份”）。
 */
const qoderStrategy: OAuthProviderStrategy = {
  flowType: "device",
  start() {
    const request = createQoderAuthRequest()
    return Promise.resolve({
      authUrl: request.authUrl,
      nonce: request.nonce,
      deviceId: request.machineId,
      pkce: request.pkce,
      interval: Math.round(QODER_DEVICE_POLL_INTERVAL_MS / 1000),
      responseExpiresIn: Math.round(QODER_DEVICE_FLOW_DEADLINE_MS / 1000),
    })
  },
  async exchange({ flow, signal }) {
    if (!flow.nonce || !flow.deviceId || !flow.pkce) {
      throw new Error("Qoder OAuth flow is missing its device-flow state")
    }
    const options: OAuthFetchOptions = { proxyUrl: flow.proxyUrl, signal }
    const device = await pollQoderDeviceToken({
      nonce: flow.nonce,
      verifier: flow.pkce.codeVerifier,
      intervalMs:
        flow.interval === undefined ?
          QODER_DEVICE_POLL_INTERVAL_MS
        : flow.interval * 1000,
      deadlineMs: QODER_DEVICE_FLOW_DEADLINE_MS,
      signal,
      proxyUrl: flow.proxyUrl,
    })
    const job = await exchangeQoderJobToken(device.token, options)
    // 身份是 best-effort：拿不到也不影响 chat（只影响展示名）。
    let name: string | undefined
    let email: string | undefined
    let userId = device.userId
    try {
      const info = await fetchQoderUserInfo(device.token, options)
      name = info.name || undefined
      email = info.email || undefined
      userId = userId || info.id
    } catch {
      // 忽略：userinfo 只是展示信息。
    }
    const conn = createOAuthConnection("qoder", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    conn.baseUrl = QODER_API_HOST
    applyQoderOAuthBundle(conn, {
      jobToken: job.token,
      jobRefreshToken: job.refreshToken,
      expiresAt: Date.now() + qoderJobTokenLifetimeMs(job),
      deviceToken: device.token,
      deviceRefreshToken: device.refreshToken,
      uid: userId,
      machineId: flow.deviceId,
      name,
      email,
    })
    upsertProviderConnection(conn)
    return conn
  },
}

const lobsteraiStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start({ proxyUrl }) {
    return createLobsteraiOAuthStart(proxyUrl ? { proxyUrl } : undefined).then(
      ({ authUrl, state, installationUuid }) => ({
        authUrl,
        state,
        nonce: installationUuid,
      }),
    )
  },
  async exchange({ flow, code }) {
    if (!code || !flow.nonce) {
      throw new Error(
        "LobsterAI OAuth flow is missing code or installation UUID",
      )
    }
    const conn = createOAuthConnection("lobsterai", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const tokens = await exchangeLobsteraiCode(
      code,
      flow.nonce,
      flowFetchOptions(flow),
    )
    if (!tokens) throw new Error("LobsterAI exchange returned no token data")
    applyLobsteraiOAuthTokens(conn, tokens, flow.nonce)
    upsertProviderConnection(conn)
    return conn
  },
}

// ── Registry ────────────────────────────────────────────────────

const factoryStrategy: OAuthProviderStrategy = {
  flowType: "device",
  async start({ proxyUrl }) {
    const device = await startFactoryDeviceFlow(
      proxyUrl ? { proxyUrl } : undefined,
    )
    return {
      verificationUri:
        device.verification_uri_complete || device.verification_uri,
      userCode: device.user_code,
      deviceCode: device.device_code,
      interval: device.interval ?? 5,
      deviceExpiresIn: device.expires_in ?? undefined,
      responseExpiresIn: device.expires_in ?? undefined,
    }
  },
  async exchange({ flow, signal }) {
    if (!flow.deviceCode) {
      throw new Error("Factory OAuth flow is missing device code")
    }
    const conn = createOAuthConnection("factory", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    // 重构出轮询器期望的设备码形状（deviceExpiresIn 只在内存里）。
    const bundle = await pollFactoryDeviceAuthorization(
      {
        device_code: flow.deviceCode,
        user_code: flow.userCode ?? "",
        verification_uri: flow.verificationUri ?? "",
        interval: flow.interval,
        expires_in: flow.deviceExpiresIn,
      },
      { ...flowFetchOptions(flow), signal },
    )
    applyFactoryOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const zcodeStrategy: OAuthProviderStrategy = {
  flowType: "device",
  async start({ proxyUrl, region }) {
    const site = normalizeZcodeSite(region)
    const s = await startZcodeSignIn(site, proxyUrl ? { proxyUrl } : undefined)
    const expiresInSec = Math.max(
      Math.round((s.expiresAtMs - Date.now()) / 1000),
      1,
    )
    return {
      authUrl: s.authUrl,
      verificationUri: s.authUrl,
      deviceCode: s.flowId,
      nonce: s.pollToken,
      interval: Math.max(Math.round(s.intervalMs / 1000), 1),
      deviceExpiresIn: expiresInSec,
      responseExpiresIn: expiresInSec,
      region: site,
    }
  },
  async exchange({ flow, signal }) {
    if (!flow.deviceCode || !flow.nonce) {
      throw new Error("ZCode OAuth flow is missing its sign-in state")
    }
    const site = normalizeZcodeSite(flow.region)
    const conn = createOAuthConnection("zcode", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await zcodeSignInAndMint(
      {
        flowId: flow.deviceCode,
        authUrl: flow.authUrl ?? "",
        pollToken: flow.nonce,
        intervalMs: Math.max(flow.interval ?? 3, 1) * 1000,
        expiresAtMs:
          Date.now() + Math.max(flow.deviceExpiresIn ?? 300, 1) * 1000,
      },
      site,
      { ...flowFetchOptions(flow), signal },
    )
    applyZcodeOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const commandCodeStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const state = generateOAuthState()
    return Promise.resolve({ authUrl: buildCommandCodeAuthUrl(state), state })
  },
  async exchange({ flow, code }) {
    if (!code) {
      throw new Error(
        "Command Code OAuth exchange requires the API key Studio posted",
      )
    }
    const conn = createOAuthConnection("commandcode-plan", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await finalizeCommandCodeBundle(code, flowFetchOptions(flow))
    applyCommandCodeOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

/** Zed 的私钥只存在内存里（回调后一次性用完），不落盘。 */
const zedPendingKeys = new Map<
  string,
  { privateKeyPem: string; systemId: string }
>()

const zedStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const key = newZedKey()
    const systemId = newZedSystemId()
    // 用 systemId 当 state：Zed 不回我们的 state，回调里只做去重/取 key 用。
    zedPendingKeys.set(systemId, {
      privateKeyPem: key.privateKeyPem,
      systemId,
    })
    return Promise.resolve({
      authUrl: zedSignInUrl(ZED_CALLBACK_PORT, key.publicKeyB64, systemId),
      state: systemId,
    })
  },
  async exchange({ flow, code }) {
    // code = `<user_id>\u0000<encrypted access token>`（combineIntoCode）。
    const [userId, ciphertext] = (code ?? "").split("\u0000")
    if (!userId || !ciphertext) {
      throw new Error("Zed OAuth exchange requires the callback values")
    }
    const pending = zedPendingKeys.get(flow.state ?? "")
    if (!pending) {
      throw new Error("Zed OAuth flow is missing its key")
    }
    zedPendingKeys.delete(flow.state ?? "")
    const accessToken = decryptZedToken(pending.privateKeyPem, ciphertext)
    const conn = createOAuthConnection("zed", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const me = await fetchZedMe(
      userId,
      accessToken,
      pending.systemId,
      flowFetchOptions(flow),
    )
    applyZedOAuthBundle(conn, {
      userId,
      accessToken,
      systemId: pending.systemId,
      org: me.org,
      login: me.login,
      name: me.name,
      plan: me.plan,
    })
    upsertProviderConnection(conn)
    return conn
  },
}

const dimagentStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const pkce = newDimagentPkce()
    const state = generateOAuthState()
    return Promise.resolve({
      authUrl: buildDimagentAuthUrl(state, pkce),
      state,
      pkce,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("DimAgent OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("DimAgent OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("dimagent", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const tokens = await exchangeDimagentCode(
      code,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyDimagentOAuthBundle(conn, dimagentBundle(tokens))
    upsertProviderConnection(conn)
    return conn
  },
}

const geminiStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const pkce = newGeminiPkce()
    const state = generateOAuthState()
    return Promise.resolve({
      authUrl: buildGeminiAuthUrl(state, pkce),
      state,
      pkce,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Gemini OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Gemini OAuth exchange requires an authorization code")
    }
    const options = flowFetchOptions(flow)
    const tokens = await exchangeGeminiCode(code, flow.pkce, options)
    const project = await resolveGeminiProject(
      tokens.access_token ?? "",
      options,
    )
    const user = await fetchGeminiUserInfo(tokens.access_token ?? "", options)
    const conn = createOAuthConnection("gemini", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    applyGeminiOAuthBundle(conn, geminiBundle(tokens, project, user))
    upsertProviderConnection(conn)
    return conn
  },
}

export const OAUTH_PROVIDER_STRATEGIES: Record<
  OAuthProviderId,
  OAuthProviderStrategy
> = {
  claude: claudeStrategy,
  codex: codexStrategy,
  xai: xaiStrategy,
  antigravity: antigravityStrategy,
  kimi: kimiStrategy,
  minimax: minimaxStrategy,
  qoder: qoderStrategy,
  factory: factoryStrategy,
  zcode: zcodeStrategy,
  "commandcode-plan": commandCodeStrategy,
  zed: zedStrategy,
  dimagent: dimagentStrategy,
  gemini: geminiStrategy,
}

/**
 * Windsurf is dual-mode: the provider stays `direct` (token paste) so legacy
 * classification (`isOAuthAccount`, refresher types, migration) is untouched,
 * while PKCE OAuth login is offered as an additional login path producing the
 * same `windsurf-native` connection shape. Kept out of
 * `OAUTH_PROVIDER_STRATEGIES` (typed by `OAuthProviderId`) on purpose.
 */
const WINDSURF_OAUTH_PROVIDER_ID = "windsurf" as const

export function getOAuthStrategy(
  provider: string,
): OAuthProviderStrategy | undefined {
  if (provider === WINDSURF_OAUTH_PROVIDER_ID) return windsurfStrategy
  if (provider === "lobsterai") return lobsteraiStrategy
  if (isCodebuddyOAuthProviderId(provider)) {
    return provider === "codebuddy-cn" ? codebuddyCnStrategy : codebuddyStrategy
  }
  if (!isOAuthProviderId(provider)) return undefined
  return OAUTH_PROVIDER_STRATEGIES[provider]
}

export function isOAuthCapableProvider(
  provider: string,
): provider is OAuthFlowProvider {
  return getOAuthStrategy(provider) !== undefined
}

export function isCallbackOAuthCapableProvider(
  provider: string,
): provider is OAuthFlowProvider {
  const strategy = getOAuthStrategy(provider)
  return (
    strategy?.flowType === "pkce-callback" || strategy?.flowType === "callback"
  )
}
