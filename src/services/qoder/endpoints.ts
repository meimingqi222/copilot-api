/**
 * Qoder 上游端点与协议常量。
 *
 * 只支持 global 客户端：授权页在 `qoder.com`，token / poll / userinfo / usage
 * 在 `openapi.qoder.sh`，推理在 `api3.qoder.sh`。
 */

/** 设备流客户端 id。 */
export const QODER_CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa"

/** 设备流授权页 host。 */
export const QODER_DEVICE_FLOW_HOST = "https://qoder.com"

/** token 轮询 / job token 交换的 host。 */
export const QODER_OPENAPI_HOST = "https://openapi.qoder.sh"

/** 模型推理 host。 */
export const QODER_API_HOST = "https://api3.qoder.sh"

/** 设备流使用的 app scheme。 */
export const QODER_REDIRECT_URI = "qoder-app://"

/** 账号页请求用的 User-Agent（usage 端点要求）。 */
export const QODER_USER_AGENT = "Qoder"

export const QODER_DEVICE_SELECT_ACCOUNTS_PATH = "/device/selectAccounts"
export const QODER_DEVICE_TOKEN_POLL_PATH = "/api/v1/deviceToken/poll"
export const QODER_DEVICE_TOKEN_REFRESH_PATH = "/api/v1/deviceToken/refresh"
export const QODER_USERINFO_PATH = "/api/v1/userinfo"
export const QODER_JOB_TOKEN_PATH = "/api/v1/me/jobToken"
export const QODER_JOB_TOKEN_REFRESH_PATH = "/api/v1/jobToken/refresh"

/** SSE 对话端点：取 LLM 结果、指定 agent_common、Encode=1 走自定义 body 编码。 */
export const QODER_CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"

/** 实时模型列表端点。 */
export const QODER_LIST_MODELS_PATH = "/algo/api/v2/model/list?Encode=1"

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

/** 完整对话端点 URL。 */
export function qoderChatUrl(): string {
  return QODER_API_HOST + QODER_CHAT_PATH
}

/** 完整模型列表 URL。 */
export function qoderListModelsUrl(): string {
  return QODER_API_HOST + QODER_LIST_MODELS_PATH
}
