/**
 * CodeBuddy Provider Runtime。
 *
 * CodeBuddy 是腾讯的编码助手，后端使用标准 OpenAI Chat Completions 协议。
 * 用户通过粘贴 CodeBuddy CLI 登录后的 accessToken + refreshToken 来接入。
 * accessToken 有效期 60 天，refreshToken 有效期 90 天，
 * 系统会在 accessToken 过期前自动调用 /v2/plugin/auth/token/refresh 刷新。
 *
 * 两个 provider 共用 codebuddy-native 协议，仅 baseUrl / X-Domain 不同：
 * - `codebuddy`（国际版）：www.codebuddy.ai，内置 GPT/Gemini/Kimi 等国际模型
 * - `codebuddy-cn`（国内版）：copilot.tencent.com，内置 DeepSeek/GLM/混元等国产模型
 */

import type { ModelMapping } from "~/lib/provider-connections"

import { refreshCodebuddyQuota } from "~/services/codebuddy/quota"
import { getProtocolAdapter } from "~/services/protocols"

import type { ProviderRuntime } from "./runtime"

// ── 国内版（codebuddy-cn）内置模型列表 ──────────────────────────────
const CODEBUDDY_CN_FALLBACK_MODELS: Array<ModelMapping> = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v3-2-volc",
  "minimax-m3",
  "minimax-m2.7",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "kimi-k3-1",
  "kimi-k2.7",
  "kimi-k2.6",
  "hy3",
  "hy4-preview",
].map((id) => ({
  publicId: id,
  upstreamId: id,
  endpoints: ["chat" as const],
  enabled: true,
  pickerEnabled: true,
}))

// ── 国际版（codebuddy）内置模型列表 ──────────────────────────────
// 从 https://www.codebuddy.ai/v3/config 抓取，排除 image/video 专用模型。
// 注意：/v3/config 列表不完整——hy4-preview / deepseek-v4.1-flash 等免费
// 模型实测可调用（chat 200）但不在 config 列表中，故在此显式补充。
const CODEBUDDY_INTL_FALLBACK_MODELS: Array<ModelMapping> = [
  // Tier slots（服务端动态解析，具体模型可变）
  "default-model",
  "default-model-lite",
  "fast-model",
  "balanced-model",
  "primary-model",
  "deep-model",
  // GPT 系列
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  // Gemini 系列
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.0-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  // 国产模型（config 列表内的）
  "deepseek-v3-2-volc",
  "glm-5.3",
  "glm-5.2",
  "glm-5.0",
  "kimi-k3",
  "kimi-k2.6",
  "kimi-k2.5",
  "minimax-m3",
  "hy3",
  // 免费模型：不在 /v3/config 列表但实测可用（2026-09 实测）
  "deepseek-v4.1-flash",
  "kimi-k2.7",
  "hy4-preview",
  "hy4-preview-x",
].map((id) => ({
  publicId: id,
  upstreamId: id,
  endpoints: ["chat" as const],
  enabled: true,
  pickerEnabled: true,
}))

/**
 * 创建 CodeBuddy provider runtime 的工厂函数。
 * 国际版与国内版共用 codebuddy-native 协议，仅 fallback 模型与 i18n key 不同。
 */
function createCodebuddyRuntime(opts: {
  id: "codebuddy" | "codebuddy-cn"
  name: string
  fallbackModels: Array<ModelMapping>
}): ProviderRuntime {
  const { id, name, fallbackModels } = opts
  return {
    id,
    descriptor: {
      id,
      name,
      icon: "bot",
      authMode: "direct",
      features: ["cooldown", "model_discovery", "quota"],
      accountFields: [
        {
          key: "accessToken",
          type: "secret",
          labelKey: `accounts.provider.${id}.fields.accessToken`,
          descriptionKey: `accounts.provider.${id}.fields.accessTokenHint`,
          placeholder: "eyJhbGciOiJSUzI1NiIs...",
        },
        {
          key: "refreshToken",
          type: "secret",
          labelKey: `accounts.provider.${id}.fields.refreshToken`,
          descriptionKey: `accounts.provider.${id}.fields.refreshTokenHint`,
          placeholder: "eyJhbGciOiJIUzUxMiIs...",
        },
      ],
    },
    supports(_connection, feature) {
      return this.descriptor.features.includes(feature)
    },
    async refreshModels(connection) {
      const adapter = getProtocolAdapter("codebuddy-native")
      if (adapter?.discoverModels && connection.credentials[0]) {
        try {
          const models = await adapter.discoverModels({
            connection,
            credential: connection.credentials[0],
          })
          if (models.length > 0) {
            // /v3/config 列表不完整（免费模型如 hy4-preview 不在其中），
            // 把 fallback 中有而发现列表没有的模型补充进去（enabled=true）。
            const known = new Set(
              models.map((m) => (m.upstreamId || m.publicId).toLowerCase()),
            )
            const missing = fallbackModels.filter(
              (m) => !known.has((m.upstreamId || m.publicId).toLowerCase()),
            )
            return missing.length > 0 ? [...models, ...missing] : models
          }
        } catch {
          // 发现失败时回退到内置列表
        }
      }
      return this.getFallbackModels?.(connection) ?? fallbackModels
    },
    getFallbackModels(_connection) {
      return fallbackModels
    },
    async refreshQuota(connection) {
      return refreshCodebuddyQuota(connection)
    },
  }
}

// 国际版（www.codebuddy.ai）
export const codebuddyProviderRuntime: ProviderRuntime = createCodebuddyRuntime(
  {
    id: "codebuddy",
    name: "CodeBuddy",
    fallbackModels: CODEBUDDY_INTL_FALLBACK_MODELS,
  },
)

// 国内版（copilot.tencent.com）
export const codebuddyCnProviderRuntime: ProviderRuntime =
  createCodebuddyRuntime({
    id: "codebuddy-cn",
    name: "CodeBuddy CN",
    fallbackModels: CODEBUDDY_CN_FALLBACK_MODELS,
  })
