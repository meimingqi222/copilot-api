/**
 * Trae provider module（CN 与 Global 共用一套机器，按站点实例化）。
 *
 * 登录：浏览器走授权页（callback 型，回调到本地 127.0.0.1:57557/authorize，
 * query 里 userJwt + userInfo）；CN 优先设备绑定 ExchangeToken，旧版轮换刷新
 * 作为兼容回退；Global 只有旧版交换。模型走 trae-cn-native adapter 的 IDE
 * agent SSE 通道。每站一个模块实例（oauth/refreshAuth 需稳定同一性）。
 */

import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import {
  traeCnCallbackConfig,
  traeGlobalCallbackConfig,
} from "~/services/providers/callbacks/trae-cn"
import {
  getTraeCnFallbackModels,
  getTraeGlobalFallbackModels,
} from "~/services/providers/model-catalogs/trae-cn"
import { fetchTraeCnQuota } from "~/lib/quota/fetchers/trae-cn"
import type { ModelMapping } from "~/lib/provider-connections"
import type { ProviderModule } from "~/services/providers/module"
import { traeCnNativeAdapter } from "~/services/protocols/trae-cn-native"
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
  newTraeDeviceFor,
  parseTraeCnCallbackCode,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CALLBACK_PORT,
  traeCnAccount,
  traeCnSignInUrl,
  type TraeCnDevice,
} from "~/services/oauth/trae-cn"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { readTraeCnModels } from "~/services/trae-cn/discovery"
import { TRAE_SITES, type TraeSite } from "~/services/trae-cn/sites"
import { defineOAuthProviderModule } from "./define"

// 登录时生成的设备指纹按 flow.state（login_trace_id）暂存——授权页与之后每个
// 请求都用同一对 deviceId/machineId（换新的会被服务端丢请求），exchange 时取回
// 落库。查不到不能现造新的：授权页用的是 start() 那次的指纹。
const traePendingDevices = new Map<
  string,
  { device: TraeCnDevice; at: number }
>()
const TRAE_CN_PENDING_TTL_MS = 30 * 60 * 1000

function traePendingPut(state: string, device: TraeCnDevice): void {
  const now = Date.now()
  for (const [k, e] of traePendingDevices) {
    if (now - e.at > TRAE_CN_PENDING_TTL_MS) traePendingDevices.delete(k)
  }
  traePendingDevices.set(state, { device, at: now })
}

function traePendingTake(state: string): TraeCnDevice | undefined {
  const e = traePendingDevices.get(state)
  traePendingDevices.delete(state)
  return e?.device
}

function traeStrategy(site: TraeSite): OAuthProviderStrategy {
  return {
    flowType: "callback",
    start() {
      const device = newTraeDeviceFor(site)
      const traceId = crypto.randomUUID()
      traePendingPut(traceId, device)
      const callback = `http://127.0.0.1:${TRAE_CN_CALLBACK_PORT}${TRAE_CN_CALLBACK_PATH}`
      return Promise.resolve({
        authUrl: traeCnSignInUrl(callback, device, traceId, site),
        state: traceId,
      })
    },
    async exchange({ flow, code }) {
      if (!code) {
        throw new Error(
          `${site.name} OAuth exchange requires the callback values`,
        )
      }
      const device = traePendingTake(flow.state ?? "")
      if (!device) {
        throw new Error(
          `${site.name} sign-in lost its device fingerprint (flow restarted?); start the sign-in again`,
        )
      }
      const signIn = await parseTraeCnCallbackCode(
        code,
        device,
        flowFetchOptions(flow),
        site,
      )
      const conn = createOAuthConnection(site.id, flow.label)
      applyFlowSettingsToConnection(conn, flow)
      // 落库模型 host 作为站点信号（共用协议时 baseUrl 优先于有歧义的协议反查）。
      conn.baseUrl = site.hosts.api
      applyTraeCnOAuthBundle(conn, signIn)
      return conn
    },
  }
}

function traeRefreshAuth(site: TraeSite) {
  return prepareOAuthRefresh(async (connection, refreshToken, options) => {
    const account = traeCnAccount(connection)
    const exchanged = await exchangeTraeCnToken(
      refreshToken,
      // clientId 决定 Trae 把新 token 签给谁，不能丢。
      account.clientId,
      {
        ...options,
        device: account,
        token: account.token,
        authHost: account.authHost,
      },
      site,
    )
    applyTraeCnTokenBundle(connection, exchanged)
  })
}

async function discoverTraeModels(
  connection: Parameters<typeof traeCnAccount>[0],
): Promise<Array<ModelMapping>> {
  const site = traeCnAccount(connection).site
  // 目录刷新是 strict：缓存的登出要重读并上报，让账号被标记重新登录。
  const { models, expired } = await readTraeCnModels(connection, {
    strict: true,
  })
  if (expired) throw expired
  return (models ?? []).map((m) => ({
    publicId: canonicalNativeModelId(m.id),
    upstreamId: m.id,
    name: m.name,
    vendor: site.id,
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    // 上游按账号声明档位；对外公布后 route-target 会按它钳制请求。
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    metadata: {
      ...(m.context ? { contextWindow: m.context } : {}),
      ...(m.maxContext && (!m.context || m.maxContext > m.context) ?
        { maxContextWindow: m.maxContext }
      : {}),
      ...(m.input ? { inputLimit: m.input } : {}),
      ...(m.output ? { outputLimit: m.output } : {}),
      // adapter 请求时按账号还原：能不能收图、档位在 Trae 叫什么。
      ...(m.multimodal === undefined ? {} : { multimodal: m.multimodal }),
      ...(m.reasoningLevels?.length ?
        { reasoningLevels: m.reasoningLevels }
      : {}),
      // Max 变体与计费倍率（展示/冷启动还原）。
      ...(m.max ? { maxBase: m.max.base, maxWindow: m.max.window } : {}),
      ...(m.devName ? { devModelName: m.devName } : {}),
      ...(m.fn ? { traeFunction: m.fn } : {}),
      ...(m.most ? { outputCap: m.most } : {}),
      ...(m.rate !== undefined ? { rate: m.rate } : {}),
      ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
    },
  }))
}

// 每站一个模块实例：getBuiltinProviderModule 每次访问都调工厂，不缓存的话
// oauth/refreshAuth 会是每次新建的对象（测试要求 getOAuthStrategy(id)===module.oauth）。
const moduleCache = new Map<TraeSite["id"], ProviderModule>()

function getTraeModuleFor(site: TraeSite): ProviderModule {
  let module = moduleCache.get(site.id)
  if (!module) {
    module = defineOAuthProviderModule({
      id: site.id,
      quota: { source: "poll" },
      callback:
        site.id === "trae-global" ?
          traeGlobalCallbackConfig
        : traeCnCallbackConfig,
      fetchQuota: fetchTraeCnQuota,
      fallbackModels:
        site.id === "trae-global" ?
          getTraeGlobalFallbackModels
        : getTraeCnFallbackModels,
      discoverModels: discoverTraeModels,
      adapter: traeCnNativeAdapter,
      oauth: traeStrategy(site),
      refreshAuth: traeRefreshAuth(site),
      refreshLeadMs: 10 * 60 * 1000, // JWT 到期前 10 分钟就换
    })
    moduleCache.set(site.id, module)
  }
  return module
}

export function getTraeCnModule(): ProviderModule {
  return getTraeModuleFor(TRAE_SITES["trae-cn"])
}

export function getTraeGlobalModule(): ProviderModule {
  return getTraeModuleFor(TRAE_SITES["trae-global"])
}
