/**
 * Builtin Provider Presets: Command Code Provider API
 *
 * https://commandcode.ai/docs/provider
 * 上游按模型家族强制区分端点:Claude 系只能走 Anthropic `/messages`,
 * 非 Claude 只能走 OpenAI `/chat/completions`,走错直接 400。
 * 因此拆成两个预设(与 aihubmix / aihubmix-anthropic 双预设模式一致),
 * Bearer 鉴权两条端点通用。
 */

import type { ProviderPreset } from "~/lib/provider-presets/types"

export const COMMANDCODE_PRESETS: Array<ProviderPreset> = [
  {
    id: "commandcode",
    name: "Command Code",
    category: "aggregator",
    protocol: "openai-compatible",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    authMode: "bearer",
    keyPlaceholder: "cmd-...",
    portalUrl: "https://commandcode.ai/settings/keys",
    description:
      "Command Code Provider API 非 Claude 模型（DeepSeek / MiniMax / MiMo / GPT 等，走 OpenAI Chat 协议；Claude 系请用 Command Code Anthropic 预设）",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "deepseek/deepseek-v4-flash",
        upstreamId: "deepseek/deepseek-v4-flash",
        endpoints: ["chat"],
      },
      {
        publicId: "deepseek/deepseek-v4.1-flash",
        upstreamId: "deepseek/deepseek-v4.1-flash",
        endpoints: ["chat"],
      },
      {
        publicId: "MiniMaxAI/MiniMax-M3",
        upstreamId: "MiniMaxAI/MiniMax-M3",
        endpoints: ["chat"],
      },
      {
        publicId: "xiaomi/mimo-v2.5-pro",
        upstreamId: "xiaomi/mimo-v2.5-pro",
        endpoints: ["chat"],
      },
      {
        publicId: "xiaomi/mimo-v2.5",
        upstreamId: "xiaomi/mimo-v2.5",
        endpoints: ["chat"],
      },
      {
        publicId: "gpt-5.5",
        upstreamId: "gpt-5.5",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "commandcode-anthropic",
    name: "Command Code (Anthropic 兼容)",
    category: "aggregator",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    authMode: "bearer",
    keyPlaceholder: "cmd-...",
    portalUrl: "https://commandcode.ai/settings/keys",
    description:
      "Command Code Provider API Claude 系模型专用（走 Anthropic Messages 协议，Bearer 鉴权）",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "claude-sonnet-5",
        upstreamId: "claude-sonnet-5",
        endpoints: ["messages"],
      },
      {
        publicId: "claude-opus-5",
        upstreamId: "claude-opus-5",
        endpoints: ["messages"],
      },
      {
        publicId: "claude-haiku-4-5",
        upstreamId: "claude-haiku-4-5",
        endpoints: ["messages"],
      },
      {
        publicId: "claude-sonnet-4-6",
        upstreamId: "claude-sonnet-4-6",
        endpoints: ["messages"],
      },
    ],
  },
]
