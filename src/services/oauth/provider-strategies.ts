import { randomUUID } from "node:crypto"

import type { OAuthAccount } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

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

export function createOAuthAccount(
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

export function applyFlowSettingsToAccount(
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
  /** Exchange authorization for tokens and apply bundle to a new account */
  exchange(input: OAuthExchangeInput): Promise<OAuthAccount>
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
    const account = createOAuthAccount("claude", flow.label)
    applyFlowSettingsToAccount(account, flow)
    const bundle = await exchangeClaudeCodeForTokens(
      code,
      flow.state,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyClaudeOAuthBundle(account, bundle)
    return account
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
    const account = createOAuthAccount("codex", flow.label)
    applyFlowSettingsToAccount(account, flow)
    const bundle = await exchangeCodexCodeForTokens(
      code,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyCodexOAuthBundle(account, bundle)
    return account
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
    const account = createOAuthAccount("xai", flow.label)
    applyFlowSettingsToAccount(account, flow)
    const bundle = await exchangeXaiCodeForTokens(
      code,
      flow.pkce,
      flow.tokenEndpoint,
      flowFetchOptions(flow),
    )
    applyXaiOAuthBundle(account, bundle)
    return account
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
    const account = createOAuthAccount("antigravity", flow.label)
    applyFlowSettingsToAccount(account, flow)
    const bundle = await exchangeAntigravityCodeForTokens(
      code,
      flow.redirectUri,
      flowFetchOptions(flow),
    )
    applyAntigravityOAuthBundle(account, bundle)
    return account
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
    const account = createOAuthAccount("kimi", flow.label)
    applyFlowSettingsToAccount(account, flow)
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
    applyKimiOAuthBundle(account, bundle)
    return account
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
