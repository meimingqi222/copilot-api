import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { fetchQoderQuota } from "~/lib/quota/fetchers/qoder"
import type { ProviderModule } from "~/services/providers/module"
import { qoderNativeAdapter } from "~/services/protocols/qoder-native"
import { qoderProviderRuntime } from "~/services/providers/qoder"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  type OAuthProviderStrategy,
  type OAuthRefreshFn,
} from "~/services/oauth/strategy-types"
import { upsertProviderConnection } from "~/lib/provider-connections"
import { QODER_API_HOST } from "~/services/qoder/endpoints"
import { type OAuthFetchOptions } from "~/services/oauth/fetch"
import {
  applyQoderOAuthBundle,
  createQoderAuthRequest,
  exchangeQoderJobToken,
  fetchQoderUserInfo,
  pollQoderDeviceToken,
  QODER_DEVICE_FLOW_DEADLINE_MS,
  QODER_DEVICE_POLL_INTERVAL_MS,
  qoderJobTokenLifetimeMs,
  applyQoderJobTokenRefresh,
  refreshQoderJobToken,
} from "~/services/oauth/qoder"

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

const refreshAuth: OAuthRefreshFn = async (
  connection,
  refreshToken,
  fetchOptions,
) => {
  const job = await refreshQoderJobToken(refreshToken, fetchOptions)
  applyQoderJobTokenRefresh(connection, job)
}

export function getQoderModule(): ProviderModule {
  return {
    id: "qoder",
    descriptor: getProviderDescriptor("qoder"),
    fetchQuota: fetchQoderQuota,
    fallbackModels: () => [],
    adapter: qoderNativeAdapter,
    createRuntime: () => qoderProviderRuntime,
    oauth: qoderStrategy,
    refreshAuth,
    refreshLeadMs: 5 * 60 * 1000,
  }
}
