import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { fetchQoderQuota } from "~/lib/quota/fetchers/qoder"
import { getQoderFallbackModels } from "~/services/providers/model-catalogs/qoder"
import { getCredentialContextString } from "~/lib/provider-connections"
import type { ProviderModule } from "~/services/providers/module"
import { qoderNativeAdapter } from "~/services/protocols/qoder-native"
import { qoderProviderRuntimeFor } from "~/services/providers/qoder"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { HTTPError } from "~/lib/error"
import { QODER_SITES, type QoderSite } from "~/services/qoder/endpoints"
import { type OAuthFetchOptions } from "~/services/oauth/fetch"
import {
  applyQoderDeviceChatRefresh,
  applyQoderOAuthBundle,
  createQoderAuthRequest,
  exchangeQoderJobToken,
  fetchQoderUserInfo,
  pollQoderDeviceToken,
  QODER_DEVICE_FLOW_DEADLINE_MS,
  QODER_DEVICE_POLL_INTERVAL_MS,
  QODER_TOKEN_FALLBACK_MS,
  qoderJobTokenLifetimeMs,
  applyQoderJobTokenRefresh,
  refreshQoderDeviceToken,
  refreshQoderJobToken,
} from "~/services/oauth/qoder"

function qoderStrategy(site: QoderSite): OAuthProviderStrategy {
  return {
    flowType: "device",
    start() {
      const request = createQoderAuthRequest(site)
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
        throw new Error(
          `${site.name} OAuth flow is missing its device-flow state`,
        )
      }
      const options: OAuthFetchOptions = { proxyUrl: flow.proxyUrl, signal }
      const device = await pollQoderDeviceToken({
        nonce: flow.nonce,
        verifier: flow.pkce.codeVerifier,
        site,
        intervalMs:
          flow.interval === undefined ?
            QODER_DEVICE_POLL_INTERVAL_MS
          : flow.interval * 1000,
        deadlineMs: QODER_DEVICE_FLOW_DEADLINE_MS,
        signal,
        proxyUrl: flow.proxyUrl,
      })

      // chat token 的两种形态：
      // - 默认：device token 换 job token（国际站、以及 CN 能接受 job token 的账号）；
      // - deviceChat 站（Qoder CN）：jobToken 交换被 4xx 拒时按 CLI 的方式
      //   直接用 device token 签 chat，记 chatTokenKind=device。
      let jobToken = device.token
      let jobRefreshToken = device.refreshToken
      // device-chat 账号的到期：响应带 expires_at 就用它，否则兜 24h
      // （缺了给 0 会让刷新调度每个请求都续期）。
      let expiresAt = device.expiresAtMs ?? Date.now() + QODER_TOKEN_FALLBACK_MS
      let chatTokenKind: "job" | "device" = "device"
      try {
        const job = await exchangeQoderJobToken(device.token, options, site)
        jobToken = job.token
        jobRefreshToken = job.refreshToken
        expiresAt = Date.now() + qoderJobTokenLifetimeMs(job)
        chatTokenKind = "job"
      } catch (error) {
        const status = error instanceof HTTPError ? error.response.status : 0
        if (!site.deviceChat || status < 400 || status >= 500) throw error
      }

      // 身份是 best-effort：拿不到也不影响 chat（只影响展示名）。
      let name: string | undefined
      let email: string | undefined
      let userId = device.userId
      try {
        const info = await fetchQoderUserInfo(device.token, options, site)
        name = info.name || undefined
        email = info.email || undefined
        userId = userId || info.id
      } catch {
        // 忽略：userinfo 只是展示信息。
      }
      const conn = createOAuthConnection(site.id, flow.label)
      applyFlowSettingsToConnection(conn, flow)
      conn.baseUrl = site.apiHost
      applyQoderOAuthBundle(conn, {
        jobToken,
        jobRefreshToken,
        expiresAt,
        deviceToken: device.token,
        deviceRefreshToken: device.refreshToken,
        uid: userId,
        machineId: flow.deviceId,
        chatTokenKind,
        name,
        email,
      })
      return conn
    },
  }
}

function qoderRefreshAuth(site: QoderSite) {
  return prepareOAuthRefresh(async (connection, refreshToken, fetchOptions) => {
    // device-chat 账号的 refreshToken 就是 device refresh token，
    // 续期端点也是 deviceToken/refresh（同一对，chat 与账号页共用）。
    const kind = getCredentialContextString(connection, "chatTokenKind")
    if (kind === "device") {
      const device = await refreshQoderDeviceToken(
        refreshToken,
        fetchOptions,
        site,
      )
      applyQoderDeviceChatRefresh(connection, device)
      return
    }
    const job = await refreshQoderJobToken(refreshToken, fetchOptions, site)
    applyQoderJobTokenRefresh(connection, job)
  })
}

// 每站一个模块实例：getBuiltinProviderModule 每次访问都调工厂，
// 不缓存的话 oauth / refreshAuth 会是每次新建的对象（测试要求
// getOAuthStrategy(id) === module.oauth）。
const moduleCache = new Map<QoderSite["id"], ProviderModule>()

function getQoderModuleFor(site: QoderSite): ProviderModule {
  let module = moduleCache.get(site.id)
  if (!module) {
    module = {
      id: site.id,
      descriptor: getProviderDescriptor(site.id),
      fetchQuota: fetchQoderQuota,
      fallbackModels: () => getQoderFallbackModels(site),
      adapter: qoderNativeAdapter,
      createRuntime: () => qoderProviderRuntimeFor(site.id),
      oauth: qoderStrategy(site),
      refreshAuth: qoderRefreshAuth(site),
      refreshLeadMs: 5 * 60 * 1000,
    }
    moduleCache.set(site.id, module)
  }
  return module
}

export function getQoderModule(): ProviderModule {
  return getQoderModuleFor(QODER_SITES.qoder)
}

export function getQoderCnModule(): ProviderModule {
  return getQoderModuleFor(QODER_SITES["qoder-cn"])
}
