/**
 * Builtin Provider Presets: 国内头部自研大模型（DeepSeek, SiliconFlow, Moonshot, Zhipu, MiniMax）
 */

import type { PresetModel, ProviderPreset } from "~/lib/provider-presets/types"

/**
 * Kimi Code（`/coding` 端点）要求客户端身份头。
 *
 * 该端点只服务它认识的编程客户端：按 User-Agent 白名单放行（Kimi CLI /
 * Claude Code / Roo Code / Kilo Code…），其他 UA 的请求被 403（agent not
 * allowed）或 429（engine overloaded）挡掉。取值与 kimi-cli 的
 * get_user_agent 一致；设备指纹（X-Msh-Device-*）是每台机器各自签的，
 * 预设不代填。
 *
 * 两个 Kimi Code 预设（国内/海外）共用这一份：它们只是域名不同，
 * 挑客户端的规则是同一个，分开放会各自漂移。
 */
const KIMI_CODING_HEADERS: Record<string, string> = {
  "User-Agent": "KimiCLI/1.52.0",
  "X-Msh-Platform": "kimi_cli",
  "X-Msh-Version": "1.52.0",
}

/**
 * Kimi Code 只有这 4 个模型 ID（kimi.com/code/docs/en 的 Model IDs），写别
 * 的一律被上游拒。`tier` 是会员档位门槛，只用于在模型列表上标一个标签：
 * `kimi-for-coding` 全档可用，`-highspeed` 需 Pro（旧名 Allegretto）及以上，
 * `k3` / `k3-256k` 需 Plus（旧名 Moderato）及以上；`k3` 的 1M 上下文还要再
 * 高一档，低档只有 262144。
 *
 * 两个 Kimi Code 预设（国内/海外）共用这一份。
 */
const KIMI_CODING_MODELS: Array<PresetModel> = [
  {
    publicId: "kimi-for-coding",
    upstreamId: "kimi-for-coding",
    endpoints: ["messages"],
  },
  {
    publicId: "kimi-for-coding-highspeed",
    upstreamId: "kimi-for-coding-highspeed",
    endpoints: ["messages"],
    tier: "Pro+",
  },
  {
    publicId: "k3",
    upstreamId: "k3",
    endpoints: ["messages"],
    tier: "Plus+",
  },
  {
    publicId: "k3-256k",
    upstreamId: "k3-256k",
    endpoints: ["messages"],
    tier: "Plus+",
  },
]

export const DOMESTIC_PRIMARY_PRESETS: Array<ProviderPreset> = [
  {
    id: "deepseek",
    name: "DeepSeek (深度求索)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.deepseek.com/api_keys",
    description: "DeepSeek V3 / R1 推理系列",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "deepseek-chat",
        upstreamId: "deepseek-chat",
        endpoints: ["chat"],
      },
      {
        publicId: "deepseek-reasoner",
        upstreamId: "deepseek-reasoner",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "deepseek-anthropic",
    name: "DeepSeek (Anthropic 兼容)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.deepseek.com/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.deepseek.com/api_keys",
    description: "DeepSeek Anthropic 协议端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "deepseek-chat",
        upstreamId: "deepseek-chat",
        endpoints: ["messages"],
      },
      {
        publicId: "deepseek-reasoner",
        upstreamId: "deepseek-reasoner",
        endpoints: ["messages"],
      },
    ],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (硅基流动)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://cloud.siliconflow.cn/account/ak",
    description: "全托管 Qwen3、GLM、DeepSeek 开源高并发推理",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        upstreamId: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        endpoints: ["chat"],
      },
      {
        publicId: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        upstreamId: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        endpoints: ["chat"],
      },
      {
        publicId: "Qwen/Qwen3-30B-A3B-Thinking-2507",
        upstreamId: "Qwen/Qwen3-30B-A3B-Thinking-2507",
        endpoints: ["chat"],
      },
      {
        publicId: "zai-org/GLM-4.6",
        upstreamId: "zai-org/GLM-4.6",
        endpoints: ["chat"],
      },
      {
        publicId: "zai-org/GLM-4.5",
        upstreamId: "zai-org/GLM-4.5",
        endpoints: ["chat"],
      },
      {
        publicId: "deepseek-ai/DeepSeek-V3",
        upstreamId: "deepseek-ai/DeepSeek-V3",
        endpoints: ["chat"],
      },
      {
        publicId: "deepseek-ai/DeepSeek-R1",
        upstreamId: "deepseek-ai/DeepSeek-R1",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot (月之暗面 / Kimi)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.moonshot.cn/console/api-keys",
    description: "Kimi K3 / 长上下文与深度思考推理模型",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    // 开放平台当前的模型 ID（platform.kimi.ai/docs/models）：旧的 kimi-k2 系列
    // 已于 2026-05-25 下线，kimi-latest 于 2026-01-28 下线，写上它们的默认
    // 列表只会让新连接一开就被上游“model not found”拒掉。
    defaultModels: [
      {
        publicId: "kimi-k3",
        upstreamId: "kimi-k3",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.7-code",
        upstreamId: "kimi-k2.7-code",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.7-code-highspeed",
        upstreamId: "kimi-k2.7-code-highspeed",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.6",
        upstreamId: "kimi-k2.6",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "moonshot-anthropic",
    name: "Moonshot (Anthropic 兼容)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.moonshot.cn/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.moonshot.cn/console/api-keys",
    description: "Moonshot Anthropic 协议端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "kimi-k3",
        upstreamId: "kimi-k3",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.7-code",
        upstreamId: "kimi-k2.7-code",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.7-code-highspeed",
        upstreamId: "kimi-k2.7-code-highspeed",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.6",
        upstreamId: "kimi-k2.6",
        endpoints: ["messages"],
      },
    ],
  },
  {
    id: "moonshot-ai",
    name: "Moonshot (Kimi 海外)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.kimi.ai/console/api-keys",
    description: "Kimi K3 / 开放平台海外站",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "kimi-k3",
        upstreamId: "kimi-k3",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.7-code",
        upstreamId: "kimi-k2.7-code",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.7-code-highspeed",
        upstreamId: "kimi-k2.7-code-highspeed",
        endpoints: ["chat"],
      },
      {
        publicId: "kimi-k2.6",
        upstreamId: "kimi-k2.6",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "moonshot-ai-anthropic",
    name: "Moonshot (Anthropic 兼容 · 海外)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.kimi.ai/console/api-keys",
    description: "Moonshot Anthropic 协议端点（海外站）",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "kimi-k3",
        upstreamId: "kimi-k3",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.7-code",
        upstreamId: "kimi-k2.7-code",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.7-code-highspeed",
        upstreamId: "kimi-k2.7-code-highspeed",
        endpoints: ["messages"],
      },
      {
        publicId: "kimi-k2.6",
        upstreamId: "kimi-k2.6",
        endpoints: ["messages"],
      },
    ],
  },
  {
    id: "moonshot-coding",
    name: "Kimi Coding",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.kimi.com/coding",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    // API Key 在 Kimi Code 控制台建，不在开放平台（拿错地方建出来的 key
    // 在这个端点上根本没额度）。
    portalUrl: "https://www.kimi.com/code/console",
    description: "Kimi 专为编程优化的 Anthropic 兼容端点",
    headers: KIMI_CODING_HEADERS,
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: KIMI_CODING_MODELS,
  },
  {
    id: "moonshot-coding-global",
    name: "Kimi Coding (海外)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.kimi.ai/coding",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://www.kimi.com/code/console",
    description: "Kimi 专为编程优化的 Anthropic 兼容端点（海外站）",
    // 同一个 Kimi Code 服务，只是域名分国内/海外：客户端白名单也一并带上，
    // 不带的话这个端点和国内那个一样会把裸客户端挡在门外。
    headers: KIMI_CODING_HEADERS,
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: KIMI_CODING_MODELS,
  },
  {
    id: "zhipu",
    name: "Zhipu AI (智谱 GLM)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authMode: "bearer",
    keyPlaceholder: "xxxxxxxx.yyyyyyyy",
    portalUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    description: "智谱 GLM-5.2 / GLM-5 / GLM-4.7 系列大模型",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "glm-5.2",
        upstreamId: "glm-5.2",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-5.1",
        upstreamId: "glm-5.1",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-5",
        upstreamId: "glm-5",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-5-turbo",
        upstreamId: "glm-5-turbo",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-4.7",
        upstreamId: "glm-4.7",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-4.5-air",
        upstreamId: "glm-4.5-air",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "zhipu-anthropic",
    name: "Zhipu AI (Anthropic 兼容)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "xxxxxxxx.yyyyyyyy",
    portalUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    description: "智谱 GLM Anthropic 协议端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "glm-5.2",
        upstreamId: "glm-5.2",
        endpoints: ["messages"],
      },
      {
        publicId: "glm-5.1",
        upstreamId: "glm-5.1",
        endpoints: ["messages"],
      },
      {
        publicId: "glm-5",
        upstreamId: "glm-5",
        endpoints: ["messages"],
      },
      {
        publicId: "glm-4.7",
        upstreamId: "glm-4.7",
        endpoints: ["messages"],
      },
    ],
  },
  {
    id: "zai",
    name: "Z.AI (智谱海外)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://z.ai",
    description: "Z.AI GLM-5 / GLM-4.7 系列海外服务端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "glm-5.2",
        upstreamId: "glm-5.2",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-5.1",
        upstreamId: "glm-5.1",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-5",
        upstreamId: "glm-5",
        endpoints: ["chat"],
      },
      {
        publicId: "glm-4.7",
        upstreamId: "glm-4.7",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "zai-anthropic",
    name: "Z.AI (Anthropic 兼容)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.z.ai/api/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://z.ai",
    description: "Z.AI Anthropic 协议端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "glm-5.2",
        upstreamId: "glm-5.2",
        endpoints: ["messages"],
      },
      {
        publicId: "glm-5.1",
        upstreamId: "glm-5.1",
        endpoints: ["messages"],
      },
      {
        publicId: "glm-4.7",
        upstreamId: "glm-4.7",
        endpoints: ["messages"],
      },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax (名之梦)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimaxi.com/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl:
      "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    description: "MiniMax M3 / M2.7 / Text-01 文本与多模态大模型",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "MiniMax-M3",
        upstreamId: "MiniMax-M3",
        endpoints: ["chat"],
      },
      {
        publicId: "MiniMax-M2.7",
        upstreamId: "MiniMax-M2.7",
        endpoints: ["chat"],
      },
      {
        publicId: "MiniMax-M2.7-highspeed",
        upstreamId: "MiniMax-M2.7-highspeed",
        endpoints: ["chat"],
      },
      {
        publicId: "MiniMax-Text-01",
        upstreamId: "MiniMax-Text-01",
        endpoints: ["chat"],
      },
    ],
  },
  {
    id: "minimax-anthropic",
    name: "MiniMax (Anthropic 兼容)",
    category: "domestic",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.minimaxi.com/anthropic",
    authMode: "header",
    headerName: "x-api-key",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.minimaxi.com",
    description: "MiniMax Anthropic 协议端点",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "MiniMax-M3",
        upstreamId: "MiniMax-M3",
        endpoints: ["messages"],
      },
      {
        publicId: "MiniMax-M2.7",
        upstreamId: "MiniMax-M2.7",
        endpoints: ["messages"],
      },
      {
        publicId: "MiniMax-Text-01",
        upstreamId: "MiniMax-Text-01",
        endpoints: ["messages"],
      },
    ],
  },
]
