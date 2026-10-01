import type { ProviderProtocol } from "~/lib/provider-connections/types"

export const PROVIDER_IDS = [
  "copilot",
  "codebuff",
  "windsurf",
  "mimo-aistudio",
  "codex",
  "claude",
  "antigravity",
  "kimi",
  "xai",
  "codebuddy",
  "codebuddy-cn",
  "lobsterai",
  "minimax",
  "qoder",
  "factory",
  "zcode",
  "commandcode-plan",
  "zed",
  "dimagent",
  "gemini",
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * Provider → Protocol 纯数据映射表(lib 级,无 services 依赖)。
 *
 * 供 lib 层(request-admission / account-adapter 等)查询 account.provider
 * 对应的协议,避免 lib → services/providers/registry 的反向依赖。
 *
 * 与 services/providers/index.ts 注册 ProtocolAdapter 时使用的 protocol
 * 保持一致:新增 provider 时只需在此表追加一行。
 */
export const PROVIDER_PROTOCOL_MAP: Record<ProviderId, ProviderProtocol> = {
  copilot: "copilot-native",
  codebuff: "codebuff-native",
  windsurf: "windsurf-native",
  "mimo-aistudio": "mimo-native",
  codex: "codex-native",
  claude: "claude-native",
  antigravity: "antigravity-native",
  kimi: "kimi-native",
  xai: "xai-native",
  codebuddy: "codebuddy-native",
  "codebuddy-cn": "codebuddy-native",
  lobsterai: "lobsterai-native",
  minimax: "minimax-native",
  qoder: "qoder-native",
  factory: "factory-native",
  zcode: "zcode-native",
  "commandcode-plan": "commandcode-native",
  zed: "zed-native",
  dimagent: "dimagent-native",
  gemini: "gemini-native",
}

export const OAUTH_PROVIDER_IDS = [
  "codex",
  "claude",
  "antigravity",
  "kimi",
  "xai",
  "minimax",
  "qoder",
  "factory",
  "zcode",
  "commandcode-plan",
  "zed",
  "dimagent",
  "gemini",
] as const

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

export const PROVIDER_FEATURES = [
  "quota",
  "cooldown",
  "native_responses",
  "native_messages",
  "embeddings",
  "device_flow",
  "model_discovery",
  "oauth",
] as const

export type ProviderFeature = (typeof PROVIDER_FEATURES)[number]

interface ProviderFieldOption {
  label: string
  value: string
}

interface ProviderFieldSchema {
  key: string
  type: "secret" | "text" | "select" | "url" | "checkbox"
  labelKey: string
  descriptionKey?: string
  required?: boolean
  placeholder?: string
  options?: Array<ProviderFieldOption>
}

export interface ProviderDescriptor {
  id: ProviderId
  name: string
  icon: string
  authMode: "device_flow" | "direct" | "oauth"
  features: Array<ProviderFeature>
  accountFields: Array<ProviderFieldSchema>
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId)
}

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.includes(value as OAuthProviderId)
}

const OAUTH_ACCOUNT_FIELDS: Array<ProviderFieldSchema> = [
  {
    key: "proxyUrl",
    type: "url",
    labelKey: "accounts.oauth.fields.proxyUrl",
    descriptionKey: "accounts.oauth.fields.proxyUrlHint",
    placeholder: "http://127.0.0.1:7890",
  },
]

/**
 * MiniMax Code 的账号域分国内版 / 国际版两套（凭证互不通用），
 * 所以区域是登录前必须选的一项：换区域等于换一套账号域 + 消息域。
 * 选项文案是域名，中英文界面下都不会歧义。
 */
const MINIMAX_ACCOUNT_FIELDS: Array<ProviderFieldSchema> = [
  {
    key: "region",
    type: "select",
    labelKey: "accounts.provider.minimax.fields.region",
    descriptionKey: "accounts.provider.minimax.fields.regionHint",
    required: true,
    options: [
      { label: "国内版 (account.minimax.cn)", value: "cn" },
      { label: "国际版 (account.minimax.io)", value: "en" },
    ],
  },
  ...OAUTH_ACCOUNT_FIELDS,
]

const OAUTH_PROVIDER_DESCRIPTORS: Record<OAuthProviderId, ProviderDescriptor> =
  {
    codex: {
      id: "codex",
      name: "Codex",
      icon: "terminal",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_responses",
        "oauth",
        "model_discovery",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    claude: {
      id: "claude",
      name: "Claude",
      icon: "sparkles",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_messages",
        "oauth",
        "model_discovery",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    antigravity: {
      id: "antigravity",
      name: "Antigravity",
      icon: "orbit",
      authMode: "oauth",
      features: ["quota", "cooldown", "oauth", "model_discovery"],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    kimi: {
      id: "kimi",
      name: "Kimi",
      icon: "moon",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "oauth",
        "model_discovery",
        "device_flow",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    xai: {
      id: "xai",
      name: "xAI",
      icon: "zap",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_responses",
        "oauth",
        "model_discovery",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    minimax: {
      id: "minimax",
      name: "MiniMax Code",
      icon: "cpu",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_messages",
        "oauth",
        "model_discovery",
        "device_flow",
      ],
      accountFields: MINIMAX_ACCOUNT_FIELDS,
    },
    // Qoder 只有 global 一套账号域，
    // 登录不需要任何附加字段：设备流授权页 + 轮询即可。
    qoder: {
      id: "qoder",
      name: "Qoder",
      icon: "qoder",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "oauth",
        "model_discovery",
        "device_flow",
      ],
      accountFields: [],
    },
    // Factory (factory.ai / Droid)：WorkOS 设备流登录，模型分走
    // Messages(/api/llm/a) 与 Responses/Chat(/api/llm/o/v1) 三种 wire。
    factory: {
      id: "factory",
      name: "Factory",
      icon: "factory",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_messages",
        "native_responses",
        "oauth",
        "model_discovery",
        "device_flow",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    // ZCode (Z.ai GLM Coding Plan)：轮询登录换铸出的 API key，走
    // Anthropic 兼容端点（api.z.ai/api/anthropic）。无刷新（key 长期有效）。
    zcode: {
      id: "zcode",
      name: "ZCode",
      icon: "zcode",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_messages",
        "oauth",
        "model_discovery",
        "device_flow",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    // Command Code Plan：CLI 浏览器登录（Studio 把 key POST 到 loopback），
    // 走 Provider API（/provider/v1 的 Chat/Responses/Anthropic）。无刷新。
    "commandcode-plan": {
      id: "commandcode-plan",
      name: "Command Code Plan",
      icon: "commandcode",
      authMode: "oauth",
      features: [
        "quota",
        "cooldown",
        "native_messages",
        "native_responses",
        "oauth",
        "model_discovery",
      ],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    // Zed：编辑器登录（RSA + loopback 回调），模型走 cloud.zed.dev/completions。
    zed: {
      id: "zed",
      name: "Zed",
      icon: "zed",
      authMode: "oauth",
      features: ["cooldown", "native_messages", "oauth", "model_discovery"],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    // DimAgent (dimagent.cn)：授权码 + PKCE（固定 client + localhost:54321
    // 回调），OpenAI 兼容 chat。
    dimagent: {
      id: "dimagent",
      name: "DimAgent",
      icon: "dimagent",
      authMode: "oauth",
      features: ["quota", "cooldown", "oauth", "model_discovery"],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
    // Gemini（Gemini CLI）：Google OAuth 登录，走 Code Assist 信封
    // （cloudcode-pa 的 /v1internal:*）。仅 Code Assist Standard/Enterprise 可用。
    gemini: {
      id: "gemini",
      name: "Gemini CLI",
      icon: "gemini",
      authMode: "oauth",
      features: ["cooldown", "oauth", "model_discovery"],
      accountFields: OAUTH_ACCOUNT_FIELDS,
    },
  }

export function getOAuthProviderDescriptor(
  provider: OAuthProviderId,
): ProviderDescriptor {
  return OAUTH_PROVIDER_DESCRIPTORS[provider]
}
