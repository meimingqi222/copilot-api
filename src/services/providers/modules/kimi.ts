import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getKimiFallbackModels } from "~/services/providers/model-catalogs/kimi"
import { fetchKimiQuota } from "~/lib/quota/fetchers/kimi"
import type { ProviderModule } from "~/services/providers/module"
import { kimiNativeAdapter } from "~/services/protocols/kimi-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  getCredentialContextString,
  setCredentialContextField,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  applyKimiOAuthBundle,
  createKimiDeviceId,
  pollKimiDeviceAuthorization,
  startKimiDeviceFlow,
  refreshKimiTokens,
  type KimiDeviceCodeResponse,
} from "~/services/oauth/kimi"

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
    return conn
  },
}

function getConnectionOAuthDeviceId(
  connection: ProviderConnection,
): string | undefined {
  const fromContext = getCredentialContextString(connection, "deviceId")
  if (fromContext) return fromContext
  const extras = connection.metadata?.credentialExtras as
    | Record<string, unknown>
    | undefined
  const value = extras?.deviceId
  return typeof value === "string" && value ? value : undefined
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const existingDeviceId = getConnectionOAuthDeviceId(connection)
    const deviceId = createKimiDeviceId(existingDeviceId)
    const bundle = await refreshKimiTokens(refreshToken, deviceId, fetchOptions)
    applyKimiOAuthBundle(connection, bundle)
    if (!existingDeviceId) {
      setCredentialContextField(connection, "deviceId", deviceId)
    }
  },
)

export function getKimiModule(): ProviderModule {
  return {
    id: "kimi",
    descriptor: getProviderDescriptor("kimi"),
    fetchQuota: fetchKimiQuota,
    fallbackModels: getKimiFallbackModels,
    adapter: kimiNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("kimi"),
    oauth: kimiStrategy,
    refreshAuth,
  }
}
