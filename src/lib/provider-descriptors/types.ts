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
  /**
   * Quota/rest state is scoped to (credential, model): one model can be
   * resting while the same credential keeps serving others. Routing and the
   * pacing limiter read this instead of matching the protocol id.
   */
  "model_scoped_quota",
] as const

export type ProviderFeature = (typeof PROVIDER_FEATURES)[number]

interface ProviderFieldOption {
  label: string
  /** i18n key; takes precedence over the literal label in the UI. */
  labelKey?: string
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
  importMethod?: "cookie" | "json" | "lobsterai" | "pat"
  manualOAuthCallback?: boolean
  /**
   * 内置网页扫码登录：服务端起临时无头浏览器出二维码，用户扫码后直接把
   * 会话换成账号（`/admin/api/web-login/*`）。用于厂商只有网页会话这一种
   * 身份、没有标准 OAuth 的提供方；有 OAuth 的不设这个。
   */
  webLogin?: boolean
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
