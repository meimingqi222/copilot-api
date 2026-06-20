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
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const OAUTH_PROVIDER_IDS = [
  "codex",
  "claude",
  "antigravity",
  "kimi",
  "xai",
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

export interface ProviderFieldOption {
  label: string
  value: string
}

export interface ProviderFieldSchema {
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
  }

export function getOAuthProviderDescriptor(
  provider: OAuthProviderId,
): ProviderDescriptor {
  return OAUTH_PROVIDER_DESCRIPTORS[provider]
}
