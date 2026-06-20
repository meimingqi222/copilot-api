import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthProviderId } from "~/lib/provider-config"

const PROVIDER_ALIASES: Record<string, OAuthProviderId> = {
  codex: "codex",
  claude: "claude",
  antigravity: "antigravity",
  kimi: "kimi",
  xai: "xai",
  "x-ai": "xai",
  grok: "xai",
}

export function normalizeCpaProviderType(
  type: string | undefined,
): OAuthProviderId | undefined {
  if (!type) {
    return undefined
  }
  const normalized = type.trim().toLowerCase()
  return (
    PROVIDER_ALIASES[normalized]
    ?? (isOAuthProviderId(normalized) ? normalized : undefined)
  )
}
