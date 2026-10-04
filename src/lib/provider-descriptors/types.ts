import type { ProviderId } from "~/lib/provider-definitions"

const PROVIDER_FEATURES = [
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

export interface ProviderFieldSchema {
  key: string
  type: "secret" | "text" | "select" | "url" | "checkbox"
  labelKey: string
  descriptionKey?: string
  required?: boolean
  placeholder?: string
  options?: Array<ProviderFieldOption>
}

export interface ProviderPresentation {
  category: "popular" | "domestic" | "ide" | "import"
  badgeKey: string
  hintKey?: string
  hasManualMode?: boolean
  importMethod?: "cookie" | "json" | "lobsterai"
  manualOAuthCallback?: boolean
}

export interface ProviderDescriptor<Id extends string = ProviderId> {
  id: Id
  name: string
  icon: string
  authMode: "device_flow" | "direct" | "oauth"
  features: Array<ProviderFeature>
  accountFields: Array<ProviderFieldSchema>
  presentation?: ProviderPresentation
}
