/**
 * Trae CN provider module。
 *
 * 登录：浏览器走 trae.cn 的授权页（callback 型，回调到本地
 * 127.0.0.1:57557/authorize，query 里 userJwt + userInfo）；
 * ExchangeToken 轮换刷新（refresh token 一次性）；
 * 模型走 trae-cn-native adapter 的 IDE agent SSE 通道。
 */

import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { traeCnCallbackConfig } from "~/services/providers/callbacks/trae-cn"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getTraeCnFallbackModels } from "~/services/providers/model-catalogs/trae-cn"
import { fetchTraeCnQuota } from "~/lib/quota/fetchers/trae-cn"
import type { ModelMapping } from "~/lib/provider-connections"
import type { ProviderModule } from "~/services/providers/module"
import { traeCnNativeAdapter } from "~/services/protocols/trae-cn-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  applyFlowSettingsToConnection,
  createOAuthConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  applyTraeCnOAuthBundle,
  applyTraeCnTokenBundle,
  exchangeTraeCnToken,
  newTraeCnDevice,
  parseTraeCnCallbackCode,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CALLBACK_PORT,
  traeCnAccount,
  traeCnSignInUrl,
  type TraeCnDevice,
} from "~/services/oauth/trae-cn"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch } from "~/services/oauth/fetch"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import {
  traeCnIdeHeaders,
  traeCnListModels,
  type TraeCnPostResult,
} from "~/services/trae-cn/client"

// 登录时生成的设备指纹按 flow.state（login_trace_id）暂存——Trae 的授权
// URL 与之后每个请求都用同一对 deviceId/machineId（插件实测换新的会被
// 服务端丢请求），exchange 时取回落库。查不到不能现造新的：授权页用的
// 是 start() 那次的指纹，换了等于签了个坏账号。
const traeCnPendingDevices = new Map<
  string,
  { device: TraeCnDevice; at: number }
>()
const TRAE_CN_PENDING_TTL_MS = 30 * 60 * 1000

function traeCnPendingPut(state: string, device: TraeCnDevice): void {
  const now = Date.now()
  for (const [k, e] of traeCnPendingDevices) {
    if (now - e.at > TRAE_CN_PENDING_TTL_MS) traeCnPendingDevices.delete(k)
  }
  traeCnPendingDevices.set(state, { device, at: now })
}

function traeCnPendingTake(state: string): TraeCnDevice | undefined {
  const e = traeCnPendingDevices.get(state)
  traeCnPendingDevices.delete(state)
  return e?.device
}

const traeCnStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const device = newTraeCnDevice()
    const traceId = crypto.randomUUID()
    traeCnPendingPut(traceId, device)
    const callback = `http://127.0.0.1:${TRAE_CN_CALLBACK_PORT}${TRAE_CN_CALLBACK_PATH}`
    return Promise.resolve({
      authUrl: traeCnSignInUrl(callback, device, traceId),
      state: traceId,
    })
  },
  async exchange({ flow, code }) {
    if (!code) {
      throw new Error("Trae CN OAuth exchange requires the callback values")
    }
    // 授权页发出时那一次的指纹才对得上；这里查不到说明 flow.state 丢了
    // （重启 / TTL 过），落一个新的 device 会签出服务端不认的账号——
    // 直接报错让用户重开 flow。
    const device = traeCnPendingTake(flow.state ?? "")
    if (!device) {
      throw new Error(
        "Trae CN sign-in lost its device fingerprint (flow restarted?); start the sign-in again",
      )
    }
    const signIn = await parseTraeCnCallbackCode(
      code,
      device,
      flowFetchOptions(flow),
    )
    const conn = createOAuthConnection("trae-cn", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    applyTraeCnOAuthBundle(conn, signIn)
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, options) => {
    const exchanged = await exchangeTraeCnToken(
      refreshToken,
      // clientId 决定 Trae 把新 token 签给谁，不能丢。
      (connection.credentials[0]?.context?.clientId as string | undefined)
        ?? undefined,
      options,
    )
    applyTraeCnTokenBundle(connection, exchanged)
  },
)

/** IDE 指纹头的 JSON POST（模型列表用；chat 走 adapter）。 */
async function postJson(
  connection: Parameters<typeof traeCnAccount>[0],
  url: string,
  body: Record<string, unknown>,
): Promise<TraeCnPostResult> {
  const credential = connection.credentials[0]!
  const token = await ensureOAuthConnectionAccessToken(connection, credential)
  const account = traeCnAccount(connection, token)
  const proxyUrl = getConnectionProxyUrl(connection)
  const response = await oauthFetch(
    url,
    {
      method: "POST",
      headers: traeCnIdeHeaders(account, { Accept: "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
    proxyUrl ? { proxyUrl } : undefined,
  )
  const text = await response.text()
  let v: Record<string, unknown> = {}
  try {
    v = JSON.parse(text) as Record<string, unknown>
  } catch {
    v = {}
  }
  return { status: response.status, text, v }
}

async function discoverTraeCnModels(
  connection: Parameters<typeof traeCnAccount>[0],
): Promise<Array<ModelMapping>> {
  const account = traeCnAccount(connection)
  const listed = await traeCnListModels(
    (url, body) => postJson(connection, url, body),
    account.apiHost,
  )
  return listed.map((m) => ({
    publicId: canonicalNativeModelId(m.id),
    upstreamId: m.id,
    name: m.name,
    vendor: "trae-cn",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    metadata: {
      ...(m.context ? { contextWindow: m.context } : {}),
      ...(m.output ? { outputLimit: m.output } : {}),
    },
  }))
}

export function getTraeCnModule(): ProviderModule {
  return {
    id: "trae-cn",
    descriptor: getProviderDescriptor("trae-cn"),
    callback: traeCnCallbackConfig,
    fetchQuota: fetchTraeCnQuota,
    fallbackModels: getTraeCnFallbackModels,
    discoverModels: discoverTraeCnModels,
    adapter: traeCnNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("trae-cn"),
    oauth: traeCnStrategy,
    refreshAuth,
    refreshLeadMs: 10 * 60 * 1000, // JWT 到期前 10 分钟就换（插件的 LEAD_MS）
  }
}
