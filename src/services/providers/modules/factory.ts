import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getFactoryFallbackModels } from "~/services/providers/model-catalogs/factory"
import { fetchFactoryQuota } from "~/lib/quota/fetchers/factory"
import type { ProviderModule } from "~/services/providers/module"
import { factoryNativeAdapter } from "~/services/protocols/factory-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  applyFactoryOAuthBundle,
  pollFactoryDeviceAuthorization,
  startFactoryDeviceFlow,
  applyFactoryTokenRefresh,
  refreshFactoryTokens,
} from "~/services/oauth/factory"

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
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const tokens = await refreshFactoryTokens(refreshToken, fetchOptions)
    applyFactoryTokenRefresh(connection, tokens)
  },
)

export function getFactoryModule(): ProviderModule {
  return {
    id: "factory",
    descriptor: getProviderDescriptor("factory"),
    fetchQuota: fetchFactoryQuota,
    fallbackModels: getFactoryFallbackModels,
    adapter: factoryNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("factory"),
    oauth: factoryStrategy,
    refreshAuth,
    refreshLeadMs: 2 * 60 * 1000,
  }
}
