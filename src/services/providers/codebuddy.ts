/**
 * CodeBuddy Provider Runtime。
 *
 * CodeBuddy 是腾讯的编码助手，后端使用标准 OpenAI Chat Completions 协议。
 * 用户通过粘贴 CodeBuddy CLI 登录后的 accessToken + refreshToken 来接入。
 * accessToken 有效期 60 天，refreshToken 有效期 90 天，
 * 系统会在 accessToken 过期前自动调用 /v2/plugin/auth/token/refresh 刷新。
 */

import type { ModelMapping } from "~/lib/provider-connections"

import { getProtocolAdapter } from "~/services/protocols"

import type { ProviderRuntime } from "./runtime"

// CodeBuddy 内置模型列表（从 /v3/config 获取的默认模型）
const CODEBUDDY_FALLBACK_MODELS: Array<ModelMapping> = [
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

export const codebuddyProviderRuntime: ProviderRuntime = {
  id: "codebuddy",
  descriptor: {
    id: "codebuddy",
    name: "CodeBuddy",
    icon: "bot",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    accountFields: [
      {
        key: "accessToken",
        type: "secret",
        labelKey: "accounts.provider.codebuddy.fields.accessToken",
        descriptionKey: "accounts.provider.codebuddy.fields.accessTokenHint",
        placeholder: "eyJhbGciOiJSUzI1NiIs...",
      },
      {
        key: "refreshToken",
        type: "secret",
        labelKey: "accounts.provider.codebuddy.fields.refreshToken",
        descriptionKey: "accounts.provider.codebuddy.fields.refreshTokenHint",
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
        if (models.length > 0) return models
      } catch {
        // 发现失败时回退到内置列表
      }
    }
    return this.getFallbackModels?.(connection) ?? CODEBUDDY_FALLBACK_MODELS
  },
  getFallbackModels(_connection) {
    return CODEBUDDY_FALLBACK_MODELS
  },
}
