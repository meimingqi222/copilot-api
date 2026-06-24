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
