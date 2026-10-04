import { randomUUID } from "node:crypto"
import type { ProviderId } from "~/lib/provider-config"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import { setConnectionSetting } from "~/lib/provider-connections"
import type { OAuthFetchOptions } from "~/services/oauth/fetch"
import type { OAuthPendingFlow } from "~/services/oauth/flows"
import type { PkceCodes } from "~/services/oauth/pkce"
import type { ProviderAuthUpdate } from "~/services/providers/auth-update"

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

export function applyFlowSettingsToConnection(
  connection: ProviderConnection,
  flow: OAuthPendingFlow,
): void {
  if (flow.proxyUrl) {
    setConnectionSetting(connection, "proxyUrl", flow.proxyUrl)
  }
}

export function flowFetchOptions(
  flow: OAuthPendingFlow,
): OAuthFetchOptions | undefined {
  return flow.proxyUrl ? { proxyUrl: flow.proxyUrl } : undefined
}

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

export interface OAuthProviderStrategy {
  readonly flowType: OAuthFlowType
  /** Start the OAuth flow (generate auth URL or device code) */
  start(input: OAuthStartInput): Promise<OAuthStartResult>
  /** Return a detached connection; the host registers and persists it. */
  exchange(input: OAuthExchangeInput): Promise<ProviderConnection>
}

export type OAuthRefreshFn = (
  connection: ProviderConnection,
  refreshToken: string,
  fetchOptions: OAuthFetchOptions,
) => Promise<ProviderAuthUpdate>
