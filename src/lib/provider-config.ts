export const PROVIDER_IDS = ["copilot", "codebuff", "windsurf"] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDER_FEATURES = [
  "quota",
  "cooldown",
  "native_responses",
  "native_messages",
  "embeddings",
  "device_flow",
  "model_discovery",
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
  authMode: "device_flow" | "direct"
  features: Array<ProviderFeature>
  accountFields: Array<ProviderFieldSchema>
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId)
}
