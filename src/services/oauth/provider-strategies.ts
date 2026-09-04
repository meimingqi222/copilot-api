import { randomUUID } from "node:crypto"

import type { OAuthProviderId } from "~/lib/provider-config"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import {
  setConnectionSetting,
  upsertProviderConnection,
} from "~/lib/provider-connections"

import type { OAuthFetchOptions } from "./fetch"
import type { OAuthPendingFlow } from "./flows"
import type { PkceCodes } from "./pkce"

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
  provider: OAuthProviderId,
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
export function applyFlowSettingsToConnection(
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

export type OAuthFlowType = "pkce-callback" | "callback" | "device"

export interface OAuthStartInput {
  proxyUrl?: string
}

export interface OAuthStartResult {
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

export interface OAuthExchangeInput {
  flow: OAuthPendingFlow
  /** Authorization code for callback-based flows */
  code?: string
  /** Abort signal for device-flow polling */
  signal?: AbortSignal
}

export interface OAuthProviderStrategy {
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

// ── Registry ────────────────────────────────────────────────────

export const OAUTH_PROVIDER_STRATEGIES: Record<
  OAuthProviderId,
  OAuthProviderStrategy
> = {
  claude: claudeStrategy,
  codex: codexStrategy,
  xai: xaiStrategy,
  antigravity: antigravityStrategy,
  kimi: kimiStrategy,
}

// ── Derived sets (replace hand-maintained Sets in oauth.ts) ─────

export const CALLBACK_OAUTH_PROVIDERS: ReadonlySet<OAuthProviderId> = new Set(
  (
    Object.entries(OAUTH_PROVIDER_STRATEGIES) as Array<
      [OAuthProviderId, OAuthProviderStrategy]
    >
  )
    .filter(
      ([, s]) => s.flowType === "pkce-callback" || s.flowType === "callback",
    )
    .map(([p]) => p),
)
