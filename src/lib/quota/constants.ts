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

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"

export const CLAUDE_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
} as const

export const KIMI_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
} as const

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
export const CODEX_RATE_LIMIT_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
export const CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
export const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
/** Keep in sync with `XAI_CLI_CLIENT_VERSION` in `src/services/xai/headers.ts`. */
export const XAI_GROK_CLIENT_VERSION = "0.2.120"

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
