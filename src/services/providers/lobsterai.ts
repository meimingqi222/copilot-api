/**
 * LobsterAI（有道龙虾）Provider Runtime。
 *
 * LobsterAI 是网易有道的编码助手，后端通过 `lobsterai-server.youdao.com`
 * 提供 OpenAI Chat Completions 代理。用户粘贴客户端登录后的
 * accessToken + refreshToken 接入，accessToken 过期前会自动调用
 * `/api/auth/refresh` 续期。
 */

import type { ModelMapping } from "~/lib/provider-connections"

import { getProtocolAdapter } from "~/services/protocols"

import type { ProviderRuntime } from "./runtime"

/**
 * 内置兜底模型列表（实测 `/api/models/available` 的模型；
 * 正常路径走 discoverModels，仅在发现失败时回退到这里）。
 */
const LOBSTERAI_FALLBACK_MODELS: Array<ModelMapping> = [
  ["deepseek-flash", "DeepSeek-V4.1-Flash"],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro"],
  ["deepseek-v4-flash", "DeepSeek-V4-Flash"],
  ["deepseek-v4-flash-vision-exp", "DeepSeek-V4-Flash-Vision-Exp"],
  ["glm-5.3", "GLM-5.3"],
  ["glm-5.3-flash", "GLM-5.3-Flash"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5", "GLM-5"],
  ["glm-5v-turbo", "GLM-5V-Turbo"],
  ["kimi-k3", "Kimi-K3"],
  ["kimi-k2.7-code", "Kimi-K2.7-Code"],
  ["kimi-k2.7-code-highspeed", "Kimi-K2.7-Code-Highspeed"],
  ["kimi-k2.6", "Kimi-K2.6"],
  ["kimi-k2.5", "Kimi-K2.5"],
  ["MiniMax-M3", "MiniMax-M3"],
  ["MiniMax-M2.7", "MiniMax-M2.7"],
  ["qwen3.8-max", "Qwen3.8-Max"],
  ["qwen3.8-flash", "Qwen3.8-Flash"],
  ["qwen3.7-max", "Qwen3.7-Max"],
  ["qwen3.7-plus", "Qwen3.7-Plus"],
  ["qwen3.6-plus", "Qwen3.6-Plus"],
  ["qwen3.5-plus-2026-04-20", "Qwen3.5-plus"],
  ["doubao-seed-2-1-pro-260628", "Doubao-Seed-2.1-Pro"],
  ["doubao-seed-2-1-turbo-260628", "Doubao-Seed-2.1-Turbo"],
  ["doubao-seed-2-0-code-preview-260215", "Doubao-Seed-2.0-Code"],
].map(([id, name]) => ({
  publicId: id,
  upstreamId: id,
  name,
  endpoints: ["chat" as const],
  enabled: true,
  pickerEnabled: true,
}))

export const lobsteraiProviderRuntime: ProviderRuntime = {
  id: "lobsterai",
  descriptor: {
    id: "lobsterai",
    name: "LobsterAI",
    icon: "bot",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    accountFields: [
      {
        key: "accessToken",
        type: "secret",
        labelKey: "accounts.provider.lobsterai.fields.accessToken",
        descriptionKey: "accounts.provider.lobsterai.fields.accessTokenHint",
        placeholder: "eyJhbGciOiJIUzUxMiIs...",
      },
      {
        key: "refreshToken",
        type: "secret",
        labelKey: "accounts.provider.lobsterai.fields.refreshToken",
        descriptionKey: "accounts.provider.lobsterai.fields.refreshTokenHint",
        placeholder: "eyJhbGciOiJIUzUxMiIs...",
      },
    ],
  },
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(connection) {
    const adapter = getProtocolAdapter("lobsterai-native")
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
    return this.getFallbackModels?.(connection) ?? LOBSTERAI_FALLBACK_MODELS
  },
  getFallbackModels(_connection) {
    return LOBSTERAI_FALLBACK_MODELS
  },
}
