/**
 * Builtin Provider Presets: 免费车道（无需账号 / API Key 的匿名上游）
 *
 * 这类上游不绑定任何用户身份：要么完全匿名，要么使用上游公开的公共池凭据。
 * 与付费预设的差别不只是「不要钱」，而是三条硬约束，改动前先读注释：
 *
 * 1. **不能带 `Authorization` 头**：Kilo 免费池对带头部的匿名请求回
 *    401 INVALID_TOKEN（实测 2026-10-09），所以这些连接不挂 credential，
 *    由路由层合成匿名凭据（见 `lib/route-target/build.ts`）。
 * 2. **模型清单会漂移**：上游随时上下线模型（Kilo 的 `isFree` 切片这次实测
 *    16 个，OpenCode Zen 的 `-free` 后缀这次实测 12 个，且 deepseek-v4-flash-free
 *    已下线、exo-free/longcat 新上线）。`defaultModels` 只是开箱可用的快照，
 *    真实来源是「在线获取模型」+ `modelDiscovery.freeOnly` 过滤。
 * 3. **数据可能被上游用于训练**：Kilo 免费池全部 `mayTrainOnYourPrompts: true`。
 *    预设描述里必须写清楚，别让用户拿它发敏感内容。
 */

import type { ProviderPreset } from "~/lib/provider-presets/types"

/**
 * Kilo AI 公共网关的免费池。
 *
 * 端点形状与 OpenAI 一致，但路径没有 `/v1`：真实地址是
 * `https://api.kilo.ai/api/gateway/{models,chat/completions}`。
 * `joinUrl` 会在缺少版本段时自动补 `/v1`，而上游同样服务
 * `/api/gateway/v1/*`（实测 200），所以 baseUrl 写到 `/api/gateway` 即可，
 * 发现与对话都落在 `.../gateway/v1/...`。
 *
 * `freeOnly` 由「在线获取模型」下发给 adapter：上游 `/models` 一次返回 390 个
 * 模型，其中只有 `isFree: true` 的 16 个匿名可用，其余会 401。
 */
export const FREE_PRESETS: Array<ProviderPreset> = [
  // ── OpenCode Zen 免费层 ──
  // 三条硬约束见 services/protocols/opencode-zen.ts 顶部注释:客户端指纹、
  // 工具白名单(只认自家四个工具名)、按 session 记账的配额。因此这条车道
  // **不接带工具的请求**(supportsToolCalling 为 false),只服务纯文本流量。
  {
    id: "opencode-zen-free",
    name: "OpenCode Zen 免费层",
    category: "free",
    protocol: "opencode-zen-free",
    // joinUrl 会补 /v1:https://opencode.ai/zen/v1/{models,chat/completions,responses}
    baseUrl: "https://opencode.ai/zen",
    keyless: true,
    description:
      "opencode.ai 公共池：12 个匿名模型（nemotron / mimo / muse-spark / step 等），"
      + "无需账号与 Key；仅支持不带工具的请求，出口地区可能被拦",
    defaultModels: [
      {
        publicId: "nemotron-3-ultra-free",
        upstreamId: "nemotron-3-ultra-free",
        endpoints: ["chat"],
      },
      {
        publicId: "nemotron-3.5-lightning-free",
        upstreamId: "nemotron-3.5-lightning-free",
        endpoints: ["chat"],
      },
      {
        publicId: "mimo-v2.6-flash-free",
        upstreamId: "mimo-v2.6-flash-free",
        endpoints: ["chat"],
      },
      {
        publicId: "space-bunny-free",
        upstreamId: "space-bunny-free",
        endpoints: ["chat"],
      },
      {
        publicId: "step-5-preview-free",
        upstreamId: "step-5-preview-free",
        endpoints: ["chat"],
      },
      {
        publicId: "ling-3.0-flash-fin-free",
        upstreamId: "ling-3.0-flash-fin-free",
        endpoints: ["chat"],
      },
      {
        publicId: "ling-3.1-flash-free",
        upstreamId: "ling-3.1-flash-free",
        endpoints: ["chat"],
      },
      {
        publicId: "longcat-2.5-preview-free",
        upstreamId: "longcat-2.5-preview-free",
        endpoints: ["chat"],
      },
      {
        publicId: "exo-free",
        upstreamId: "exo-free",
        endpoints: ["chat"],
      },
      {
        publicId: "jev-1.13-free",
        upstreamId: "jev-1.13-free",
        endpoints: ["chat"],
      },
      // muse-spark 系只服务 /responses,打 /chat/completions 会 400
      {
        publicId: "muse-spark-1.3-contributor-free",
        upstreamId: "muse-spark-1.3-contributor-free",
        endpoints: ["responses"],
      },
      {
        publicId: "muse-spark-1.2-contributor-free",
        upstreamId: "muse-spark-1.2-contributor-free",
        endpoints: ["responses"],
      },
    ],
  },
  {
    id: "kilo-free",
    name: "Kilo AI 免费池",
    category: "free",
    protocol: "openai-compatible",
    baseUrl: "https://api.kilo.ai/api/gateway",
    keyless: true,
    description:
      "Kilo AI 公共网关免费池：16 个匿名模型（nemotron / ling / step / poolside 等），"
      + "无需账号与 Key；prompt 可能被上游记录并用于改进服务，勿发敏感内容",
    defaultModels: [
      {
        publicId: "kilo-auto/free",
        upstreamId: "kilo-auto/free",
        endpoints: ["chat"],
      },
      {
        publicId: "nvidia/nemotron-3-ultra-550b-a55b:free",
        upstreamId: "nvidia/nemotron-3-ultra-550b-a55b:free",
        endpoints: ["chat"],
      },
      {
        publicId: "nvidia/nemotron-3.5-lightning:free",
        upstreamId: "nvidia/nemotron-3.5-lightning:free",
        endpoints: ["chat"],
      },
      {
        publicId: "nvidia/nemotron-3-super-120b-a12b:free",
        upstreamId: "nvidia/nemotron-3-super-120b-a12b:free",
        endpoints: ["chat"],
      },
      {
        publicId: "nvidia/nemotron-3.5-content-safety:free",
        upstreamId: "nvidia/nemotron-3.5-content-safety:free",
        endpoints: ["chat"],
      },
      {
        publicId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        upstreamId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        endpoints: ["chat"],
      },
      {
        publicId: "inclusionai/ling-3.1-flash",
        upstreamId: "inclusionai/ling-3.1-flash",
        endpoints: ["chat"],
      },
      {
        publicId: "stepfun/step-5-preview-free",
        upstreamId: "stepfun/step-5-preview-free",
        endpoints: ["chat"],
      },
      {
        publicId: "dots-studio/dots-3-note-preview:free",
        upstreamId: "dots-studio/dots-3-note-preview:free",
        endpoints: ["chat"],
      },
      {
        publicId: "poolside/laguna-s-2.1:free",
        upstreamId: "poolside/laguna-s-2.1:free",
        endpoints: ["chat"],
      },
      {
        publicId: "poolside/laguna-xs-2.1:free",
        upstreamId: "poolside/laguna-xs-2.1:free",
        endpoints: ["chat"],
      },
      {
        publicId: "thinkingmachines/inkling-small:free",
        upstreamId: "thinkingmachines/inkling-small:free",
        endpoints: ["chat"],
      },
      {
        publicId: "liquid/lfm-2.5-2.6b:free",
        upstreamId: "liquid/lfm-2.5-2.6b:free",
        endpoints: ["chat"],
      },
      {
        publicId: "cohere/north-mini-code:free",
        upstreamId: "cohere/north-mini-code:free",
        endpoints: ["chat"],
      },
      {
        publicId: "stealth/glyph-cluster",
        upstreamId: "stealth/glyph-cluster",
        endpoints: ["chat"],
      },
      {
        publicId: "openrouter/free",
        upstreamId: "openrouter/free",
        endpoints: ["chat"],
      },
    ],
  },
]
