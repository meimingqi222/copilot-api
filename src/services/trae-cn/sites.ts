/**
 * Trae 的两个账号域（realm）共用一套实现：
 *
 *   trae-cn     : trae.cn（字节跳动 AI IDE 中国站），积分计费
 *   trae-global : trae.ai（国际站），美元计费，US/SG 双部署
 *
 * 两站协议一致、账号互不相通，只有 host / 客户端版本 / 计费页 / 错误码不同。
 * 每个 realm 是一张表（TRAE_SITES），请求、流式、工具、续期的机器代码共用，
 * 改一处两站都受益——与 magpie 的 packages/trae 同构。
 *
 * 签到（每日签到）刻意不在此实现。
 */

import { randomBytes, randomInt } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections/types"

type TraeSiteId = "trae-cn" | "trae-global"

/** 登录时生成、之后每个请求都带的设备指纹。 */
export interface TraeDevice {
  /** CN 16 位数字、Global 19 位；旧账号保留原 ID。 */
  deviceId: string
  /** 16 字节 hex。 */
  machineId: string
  devicePublicKey?: string
  devicePrivateKey?: string
}

/** apiOf / usage host 需要的账号上下文（登录落库的 host/region 等）。 */
interface TraeHostContext {
  /** 登录命名的模型 host（未解析）。 */
  api?: string
  /** 登录命名的原始 host（企业 console 判定用）。 */
  host?: string
  region?: string
  /** false = 企业 console 拒过 chat（4245），回退消费网关。 */
  consoleChat?: boolean
}

interface TraeUsageSpec {
  kind: "credits" | "dollar"
  path: string
  label: string
  body: Record<string, unknown>
  /** 企业（SaaS）账号在 console 上的席位额度三页。 */
  ent?: { quota: string; spent: string; core: string }
}

export interface TraeSite {
  id: TraeSiteId
  name: string
  /** 错误/消息里带的域名。 */
  realm: string
  /** 授权页与 authHost 校验用的裸域。 */
  webHost: string
  hosts: {
    web: string
    auth: string
    api: string
    /** Global US 模型部署。 */
    us?: string
    /** Global 美元计费页。 */
    pay?: string
    usPay?: string
    /** 企业 console（席位计费）。 */
    console: string
  }
  /** 登录命名此 host 即企业账号。 */
  consoleHost: string
  /** console 是否接受 IDE token（CN 实测接受；Global 未实测，401 不算登出）。 */
  consoleTakesIdeToken: boolean
  clientId: string
  appId: string
  /** 授权页自称的 IDE 版本。 */
  ideVersion: string
  ideVersionCode: string
  /** 模型网关自称的客户端版本（TRAE SOLO）。 */
  clientVersion: string
  clientVersionCode: string
  pluginVersion: string
  brand: string
  functions: ReadonlyArray<string>
  /** 设备绑定续期（CN）；Global 无，仅旧版 /cloudide 交换。 */
  deviceExchange?: {
    path: string
    as: ReadonlyArray<{ clientId: string; platform: string; version: string }>
  }
  /** 列表是否隐藏 Auto 路由/paygo 孪生（is_invisible_to_user）。 */
  hidesInvisible: boolean
  lapsed: ReadonlyArray<string | number>
  quota: ReadonlyArray<string | number>
  usage: TraeUsageSpec
  regionOf: (info: Record<string, unknown>) => string
  /** 账号的模型 host（含企业 console 与 region 选择）。 */
  apiOf: (a: TraeHostContext) => string
  /** 登录命名的 host 是否是本站模型 host。 */
  modelHost: (h: unknown) => boolean
}

const TRAE_DOMAINS = ["trae.cn", "trae.ai", "mchost.guru"]

/**
 * 登录命名的 host：形如 https、无端口/凭据/query/hash、落在 Trae 自己的域上
 * 才取（origin + path，去尾斜杠）；否则 ""（不采用）。
 */
function traeHost(h: unknown): string {
  try {
    const u = new URL(String(h ?? "").trim())
    if (
      u.protocol !== "https:"
      || u.username
      || u.password
      || u.port
      || u.search
      || u.hash
    ) {
      return ""
    }
    const n = u.hostname.toLowerCase()
    if (!TRAE_DOMAINS.some((d) => n === d || n.endsWith("." + d))) return ""
    return (u.origin + u.pathname).replace(/\/+$/, "")
  } catch {
    return ""
  }
}

/** 登录命名的 token host（企业的可能与消费站不同），落在本站 webHost 域才取。 */
export function authHostOf(h: unknown, site: TraeSite): string {
  const t = traeHost(h)
  if (!t) return ""
  const n = new URL(t).hostname
  return n === site.webHost || n.endsWith("." + site.webHost) ? t : ""
}

/**
 * 保留登录 userInfo 里说明账号种类的字段（tenant/enterprise/login type 等），
 * 仅纯值、绝不含疑似密钥；只落库展示，不随请求发出。
 */
export function accountOf(
  info: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(info ?? {})) {
    if (
      !/tenant|enterprise|saas|login|org|team|sso|^ent|usertype|accounttype/i.test(
        k,
      )
    ) {
      continue
    }
    if (/token|secret|key|password|cookie|session|jwt/i.test(k)) continue
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      out[k] = v as string | number | boolean
    }
  }
  return out
}

const CN_MODEL_HOST = /(^|\.)mchost\.guru$|^trae-api-/i
const CN_CONSOLE_HOST = "console.enterprise.trae.cn"

export const TRAE_SITES: Record<TraeSiteId, TraeSite> = {
  "trae-cn": {
    id: "trae-cn",
    name: "Trae CN",
    realm: "Trae CN",
    webHost: "trae.cn",
    hosts: {
      web: "https://www.trae.cn",
      auth: "https://api.trae.cn",
      api: "https://trae-api-cn.mchost.guru",
      console: "https://console.enterprise.trae.cn",
    },
    consoleHost: CN_CONSOLE_HOST,
    consoleTakesIdeToken: true,
    clientId: "ono9krqynydwx5",
    appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ideVersion: "3.3.65",
    ideVersionCode: "20260401",
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    pluginVersion: "2.3.24254",
    brand: "ASUS TUF Gaming A15 FA507RM_FA507RM",
    functions: [
      "chat_v3",
      "solo_work_lite",
      "solo_agent",
      "solo_agent_lite",
      "solo_coder",
    ],
    deviceExchange: {
      path: "/trae/api/v3/oauth/ExchangeToken",
      as: [
        { clientId: "en1oxy7wnw8j9n", platform: "SOLO_PC", version: "0.1.64" },
        { clientId: "ono9krqynydwx5", platform: "IDE_PC", version: "3.3.99" },
      ],
    },
    hidesInvisible: false,
    lapsed: [1001, "1001", 401, "401"],
    quota: [4008, "4008", 1005, "1005"],
    usage: {
      kind: "credits",
      path: "/trae/api/v2/pay/ide_user_ent_usage",
      label: "credits",
      body: { require_usage: true, req_source: 0 },
      ent: {
        quota: "/trae/gtm/tob/api/v1/config/get_personal_quota",
        spent: "/trae/gtm/tob/api/v1/config/get_user_model_usage",
        core: "/trae/gtm/tob/api/v1/config/get_personal_core_data",
      },
    },
    regionOf: () => "",
    apiOf: (a) => {
      const site = TRAE_SITES["trae-cn"]
      const h = traeHost(a.api)
      if (h && new URL(h).hostname.toLowerCase() === CN_CONSOLE_HOST) {
        return a.consoleChat === false ? site.hosts.api : site.hosts.console
      }
      return h && site.modelHost(h) ? h : site.hosts.api
    },
    modelHost: (h) => {
      const t = traeHost(h)
      if (!t) return false
      const n = new URL(t).hostname
      return (
        CN_MODEL_HOST.test(n)
        || (/\.trae\.cn$/i.test(n) && !/^(www|api|grow[^.]*)\./i.test(n))
      )
    },
  },
  "trae-global": {
    id: "trae-global",
    name: "Trae Global",
    realm: "Trae Global",
    webHost: "trae.ai",
    hosts: {
      web: "https://www.trae.ai",
      auth: "https://growsg-normal.trae.ai",
      api: "https://coresg-normal.trae.ai",
      us: "https://coreva-normal.trae.ai",
      pay: "https://api-sg-central.trae.ai",
      usPay: "https://api-us-east.trae.ai",
      console: "https://console.enterprise.trae.ai",
    },
    consoleHost: "console.enterprise.trae.ai",
    // 未实测：国际企业 console 对异域 token 回「请先登录」，与无 token 无异，
    // 故其 401 只当读取失败，绝不标登出。
    consoleTakesIdeToken: false,
    clientId: "ono9krqynydwx5",
    appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ideVersion: "3.5.51",
    ideVersionCode: "20260401",
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    pluginVersion: "2.3.62834",
    brand: "ASUS TUF Gaming A15 FA507RM_FA507RM",
    functions: [
      "chat_v3",
      "solo_work_lite",
      "solo_agent",
      "solo_agent_lite",
      "solo_coder",
    ],
    hidesInvisible: true,
    lapsed: [1001, "1001", 20101, "20101", 401, "401"],
    quota: [4008, "4008", 1005, "1005", 4011, "4011"],
    usage: {
      kind: "dollar",
      path: "/trae/api/v1/pay/user_current_entitlement_list",
      label: "usage",
      body: {},
      ent: {
        quota: "/trae/gtm/tob/api/v1/config/get_personal_quota",
        spent: "/trae/gtm/tob/api/v1/config/get_user_model_usage",
        core: "/trae/gtm/tob/api/v1/config/get_personal_core_data",
      },
    },
    regionOf: (info) =>
      String(
        info?.region ?? info?.aiRegion ?? info?.Region ?? info?.AIRegion ?? "",
      ).trim(),
    apiOf: (a) => {
      const site = TRAE_SITES["trae-global"]
      const h = traeHost(a.api)
      const n = h ? new URL(h).hostname : ""
      const region = String(a.region ?? "").toUpperCase()
      if (n === site.consoleHost) {
        if (a.consoleChat !== false) return site.hosts.console
        return /^US(?:[-_ ]|$)/.test(region) ? site.hosts.us! : site.hosts.api
      }
      if (
        /coreva/i.test(n)
        || /api-us(?:[-.]|$)/i.test(n)
        || /^US(?:[-_ ]|$)/.test(region)
      ) {
        return site.hosts.us!
      }
      if (/coresg/i.test(n)) return h
      if (/\.trae\.ai$/i.test(n) && !/^(www\.|api[-.]|grow)/i.test(n)) return h
      return site.hosts.api
    },
    modelHost: (h) => {
      const t = traeHost(h)
      return !!t && /(^|\.)trae\.ai$/i.test(new URL(t).hostname)
    },
  },
}

/** provider id → 站点；未知 id 按 CN 处理（历史默认）。 */
function traeSiteForProvider(provider: string | undefined): TraeSite {
  return provider === "trae-global" ?
      TRAE_SITES["trae-global"]
    : TRAE_SITES["trae-cn"]
}

/**
 * connection → 站点。trae-cn / trae-global 共用 trae-cn-native 协议，protocol
 * 反查会被后写的 provider 覆盖，所以优先按登录落库的 baseUrl 匹配模型 host，
 * 再按 metadata.provider，最后回退协议反查。
 */
export function traeSiteForConnection(
  connection: ProviderConnection,
): TraeSite {
  const base = connection.baseUrl
  if (typeof base === "string" && base) {
    const byBase = Object.values(TRAE_SITES).find(
      (s) => s.hosts.api === base || s.hosts.us === base,
    )
    if (byBase) return byBase
  }
  const provider = connection.metadata?.provider
  // 两者都无时按 CN（协议本名，历史默认），不用有歧义的协议反查。
  return traeSiteForProvider(
    typeof provider === "string" ? provider : "trae-cn",
  )
}

/** 计费页 host：CN 积分在 auth host；Global 美元按 region 选 US/SG。 */
export function traeUsageHost(site: TraeSite, a: TraeHostContext): string {
  if (site.usage.kind === "credits") return site.hosts.auth
  const us =
    /^US(?:[-_ ]|$)/i.test(String(a.region ?? ""))
    || /api-us|coreva/i.test(String(a.api ?? ""))
  return us ? site.hosts.usPay! : site.hosts.pay!
}

/** 企业账号：登录把本站 console 命名为账号 host。 */
export function isTraeEnterprise(a: TraeHostContext, site: TraeSite): boolean {
  const named = site.consoleHost.toLowerCase()
  if (!named || !a.host) return false
  try {
    return new URL(String(a.host)).hostname.toLowerCase() === named
  } catch {
    return false
  }
}

const digits = (n: number): string =>
  Array.from({ length: n }, (_, i) =>
    i === 0 ? randomInt(1, 10) : randomInt(0, 10),
  ).join("")

/** 新设备指纹：CN 16 位、Global 19 位（Trae 设备服务给客户端的形状）。 */
export function newTraeDevice(site: TraeSite): TraeDevice {
  return {
    deviceId: digits(site.id === "trae-cn" ? 16 : 19),
    machineId: randomBytes(16).toString("hex"),
  }
}
