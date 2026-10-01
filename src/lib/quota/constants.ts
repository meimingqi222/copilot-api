export const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const

/**
 * Antigravity 配额请求的 header 模板。
 * User-Agent 使用占位符，在运行时由 buildAntigravityHubUserAgent() 替换为动态版本。
 */
export const ANTIGRAVITY_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "$ANTIGRAVITY_UA$",
} as const

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"

export const CLAUDE_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
} as const

export const KIMI_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
}

/**
 * MiniMax Code 的订阅用量端点。
 *
 * 路径挂在 **api 域**（`api.minimax.cn` / `api.minimax.io` / `api.minimaxi.com`）
 * 上，而不是模型面用的 `agent.*` 域（后者对这个路径回 404）。域名按登录
 * 区域选，见 `MINIMAX_REGIONS[region].quotaHosts`。
 *
 * 官方客户端还会发 `yy` / `x-timestamp` / `x-signature` 三个“第一方客户端”
 * 标识头；本代理**不伪造**这些身份标记（Messages 链路只靠 Bearer 即可），
 * 所以这里只有 Bearer。若上游因此拒绝，配额卡片会如实地报错。
 */
export const MINIMAX_CODING_PLAN_REMAINS_PATH =
  "/v1/api/openplatform/coding_plan/remains"

export const MINIMAX_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  Accept: "application/json",
} as const

/**
 * MiniMax Code 的**积分钱包**端点。
 *
 * 积分（Credits）与 Token Plan 是两笔独立的钱：`coding_plan/remains` 只描述
 * 订阅窗口，从未订阅（或订阅已到期）的账号在那里拿到的是
 * `2062 no active token plan subscription`，而积分仍在。官方客户端的账号页
 * 读的就是这两个端点：
 *
 *   POST {agent}/matrix/api/v1/commerce/get_membership_info   ← 首选
 *        `op_credit_summary.total_remaining_amount`（迁移到 OP 后的现行口径）
 *   POST {agent}/matrix/api/v1/user/get_user_extra_info       ← 兜底
 *        个人工作区（`workspace_type === 0`）上的 `opcredit_balance`
 *
 * 与 remains 不同，这两个路径挂在 **agent 域**（模型面同域，见
 * `MINIMAX_REGIONS[region].agent`），且只认 Bearer：实测不发送官方客户端那组
 * `yy` / `x-timestamp` / `x-signature` 第一方标识头也能正常返回。
 */
export const MINIMAX_MEMBERSHIP_INFO_PATH =
  "/matrix/api/v1/commerce/get_membership_info"

export const MINIMAX_USER_EXTRA_INFO_PATH =
  "/matrix/api/v1/user/get_user_extra_info"

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
export const CODEX_RATE_LIMIT_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
export const CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
/** Keep in sync with `XAI_CLI_CLIENT_VERSION` in `src/services/xai/headers.ts`. */
const XAI_GROK_CLIENT_VERSION = "0.2.120"

export const CODEX_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
} as const

export const XAI_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "x-xai-token-auth": "xai-grok-cli",
  "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
  Accept: "*/*",
  "User-Agent": `grok-pager/${XAI_GROK_CLIENT_VERSION} grok-shell/${XAI_GROK_CLIENT_VERSION} (macos; aarch64)`,
} as const

export const CLAUDE_USAGE_WINDOW_KEYS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_cowork",
  "iguana_necktie",
] as const
