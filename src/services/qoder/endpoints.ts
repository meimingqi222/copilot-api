/**
 * Qoder 上游端点与协议常量。
 *
 * 两个站点，协议完全一致、账号互不相通：
 *
 *   qoder    : qoder.com 国际站，openapi.qoder.sh / api3.qoder.sh
 *   qoder-cn : qoder.cn 中国站，openapi.qoder.com.cn / gateway.qoder.com.cn
 *
 * CN 站的差异：device-flow client id 是它自己 CLI（@qodercn-ai/qoderclicn）
 * 的生产值；授权页不带 redirect_uri；CN CLI 从不换 job token——jobToken
 * 交换被 4xx 拒时按 CLI 的方式用 device token 直签 chat（site.deviceChat）。
 */

import { getConnectionProvider } from "~/lib/provider-connections"

/** 一个 Qoder 站点的常量（授权页 / 账号端点 / 推理端点各一个 host）。 */
export interface QoderSite {
  /** provider id，也是站点 id。 */
  id: "qoder" | "qoder-cn"
  /** 展示名。 */
  name: string
  /** 设备流 client id。 */
  clientId: string
  /** 设备流授权页 host。 */
  deviceFlowHost: string
  /** token 轮询 / job token / userinfo / usage 的 host。 */
  openapiHost: string
  /** 模型推理 host（chat 与 model/list）。 */
  apiHost: string
  /** 授权页 redirect_uri；空串 = 该站授权页不带它（Qoder CN）。 */
  redirectUri: string
  /** jobToken 被 4xx 拒时回退到 device token 直签 chat（CN 的 CLI 行为）。 */
  deviceChat: boolean
}

export const QODER_SITES: Record<QoderSite["id"], QoderSite> = {
  qoder: {
    id: "qoder",
    name: "Qoder",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    deviceFlowHost: "https://qoder.com",
    openapiHost: "https://openapi.qoder.sh",
    apiHost: "https://api3.qoder.sh",
    redirectUri: "qoder-app://",
    deviceChat: false,
  },
  "qoder-cn": {
    id: "qoder-cn",
    name: "Qoder CN",
    // Qoder CN 的 CLI（@qodercn-ai/qoderclicn 1.1.65）的生产 client id。
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    deviceFlowHost: "https://qoder.cn",
    openapiHost: "https://openapi.qoder.com.cn",
    apiHost: "https://gateway.qoder.com.cn",
    redirectUri: "",
    deviceChat: true,
  },
}

/** provider id → 站点；未知 id 按国际站处理。 */
export function qoderSiteForProvider(provider: string | undefined): QoderSite {
  return provider === "qoder-cn" ? QODER_SITES["qoder-cn"] : QODER_SITES.qoder
}

/**
 * connection → 站点。qoder / qoder-cn 共用 qoder-native 协议，protocol →
 * provider 的反向映射会被后写的 provider 覆盖（connection 没有
 * metadata.provider 时推错站），所以优先按登录时落库的 baseUrl 匹配站点，
 * 匹配不到再回退到 provider。
 */
export function qoderSiteForConnection(
  connection: Parameters<typeof getConnectionProvider>[0],
): QoderSite {
  const base = connection.baseUrl
  if (typeof base === "string" && base) {
    const byBase = Object.values(QODER_SITES).find((s) => s.apiHost === base)
    if (byBase) return byBase
  }
  return qoderSiteForProvider(getConnectionProvider(connection))
}

// ── 全局站常量（沿用旧导出，等价 QODER_SITES.qoder 的字段） ──────

/** 设备流客户端 id。 */
export const QODER_CLIENT_ID = QODER_SITES.qoder.clientId

/** 设备流授权页 host。 */
export const QODER_DEVICE_FLOW_HOST = QODER_SITES.qoder.deviceFlowHost

/** token 轮询 / job token 交换的 host。 */
export const QODER_OPENAPI_HOST = QODER_SITES.qoder.openapiHost

/** 模型推理 host。 */
export const QODER_API_HOST = QODER_SITES.qoder.apiHost

/** 设备流使用的 app scheme。 */
export const QODER_REDIRECT_URI = QODER_SITES.qoder.redirectUri

/** 账号页请求用的 User-Agent（usage 端点要求）。 */
export const QODER_USER_AGENT = "Qoder"

export const QODER_DEVICE_SELECT_ACCOUNTS_PATH = "/device/selectAccounts"
export const QODER_DEVICE_TOKEN_POLL_PATH = "/api/v1/deviceToken/poll"
export const QODER_DEVICE_TOKEN_REFRESH_PATH = "/api/v1/deviceToken/refresh"
export const QODER_USERINFO_PATH = "/api/v1/userinfo"
export const QODER_JOB_TOKEN_PATH = "/api/v1/me/jobToken"
export const QODER_JOB_TOKEN_REFRESH_PATH = "/api/v1/jobToken/refresh"

/** SSE 对话端点：取 LLM 结果、指定 agent_common、Encode=1 走自定义 body 编码。 */
const QODER_CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"

/** 实时模型列表端点。 */
const QODER_LIST_MODELS_PATH = "/algo/api/v2/model/list?Encode=1"

/** 桌面客户端的账号用量端点。 */
export const QODER_ACCOUNT_USAGE_PATH = "/sash/api/v2/me/usage"

/** COSY 协议的客户端版本号。 */
export const QODER_COSY_VERSION = "1.1.49"

/**
 * body 自定义 base64 字母表（64 字符，从 Qoder 客户端内存 dump）。
 * '!' 是第 64 个字符（6-bit 值 63），'$' 是占位符（不携带数据）。
 */
export const QODER_BODY_ALPHABET =
  "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"

/** 完整对话端点 URL（默认全局站；CN 站传 base 覆盖）。 */
export function qoderChatUrl(base?: string): string {
  return (base ?? QODER_API_HOST) + QODER_CHAT_PATH
}

/** 完整模型列表 URL（默认全局站；CN 站传 base 覆盖）。 */
export function qoderListModelsUrl(base?: string): string {
  return (base ?? QODER_API_HOST) + QODER_LIST_MODELS_PATH
}
