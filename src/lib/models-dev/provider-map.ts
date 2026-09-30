import type { ProviderId } from "~/lib/provider-config"

export const MODELS_DEV_API_URL = "https://models.dev/api.json"

export const MODELS_DEV_PROVIDER_PRIORITY: Partial<
  Record<ProviderId, Array<string>>
> = {
  copilot: ["github-copilot", "github-models"],
  codex: ["openai", "github-copilot"],
  claude: ["anthropic", "github-copilot"],
  antigravity: ["google", "google-vertex", "google-vertex-anthropic"],
  kimi: ["moonshotai", "moonshotai-cn", "kimi-for-coding"],
  xai: ["xai"],
  "mimo-aistudio": [
    "xiaomi",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp",
  ],
  // MiniMax Code（订阅制）：models.dev 有两个 coding-plan 专属条目
  // （api 字段即订阅 Anthropic 端点），后面两个是平台 API 条目，
  // 对订阅凭证只是最接近的价格参照。
  minimax: [
    "minimax-cn-coding-plan",
    "minimax-coding-plan",
    "minimax-cn",
    "minimax",
  ],
}

export const GLOBAL_MODEL_PROVIDER_PRIORITY = [
  "github-copilot",
  "anthropic",
  "openai",
  "google",
  "xiaomi",
  "xai",
  "moonshotai",
] as const
