import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getMinimaxFallbackModels } from "~/services/providers/model-catalogs/minimax"
import { fetchMinimaxQuota } from "~/lib/quota/fetchers/minimax"
import type { ProviderModule } from "~/services/providers/module"
import { minimaxNativeAdapter } from "~/services/protocols/minimax-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { generatePkceCodes } from "~/services/oauth/pkce"
import {
  applyMinimaxOAuthBundle,
  normalizeMinimaxRegion,
  pollMinimaxDeviceAuthorization,
  startMinimaxDeviceFlow,
  refreshMinimaxTokens,
  resolveMinimaxRegion,
  type MinimaxDeviceCodeResponse,
} from "~/services/oauth/minimax"

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
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    // 账号域由 connection 上的 region 决定（baseUrl 里也带着区域，
    // resolveMinimaxRegion 会在 context 缺失时从那里反查）。
    const region = resolveMinimaxRegion(connection)
    const bundle = await refreshMinimaxTokens(
      refreshToken,
      region,
      fetchOptions,
    )
    applyMinimaxOAuthBundle(connection, bundle)
  },
)

export function getMinimaxModule(): ProviderModule {
  return {
    id: "minimax",
    descriptor: getProviderDescriptor("minimax"),
    fetchQuota: fetchMinimaxQuota,
    fallbackModels: getMinimaxFallbackModels,
    adapter: minimaxNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("minimax"),
    oauth: minimaxStrategy,
    refreshAuth,
    refreshLeadMs: 5 * 60 * 1000,
  }
}
