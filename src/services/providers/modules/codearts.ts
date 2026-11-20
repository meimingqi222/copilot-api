import {
  codeArtsFallbackModels,
  discoverCodeArtsModels,
} from "~/services/codearts/models"
import {
  codeArtsCallback,
  codeArtsOAuth,
  refreshCodeArts,
} from "~/services/codearts/oauth"
import { fetchCodeArtsQuota } from "~/services/codearts/quota"
import { codeArtsNativeAdapter } from "~/services/protocols/codearts-native"
import type { ProviderModule } from "~/services/providers/module"
import { defineOAuthProviderModule } from "~/services/providers/modules/define"

export function getCodeArtsModule(): ProviderModule {
  return defineOAuthProviderModule({
    id: "codearts",
    quota: { source: "poll" },
    adapter: codeArtsNativeAdapter,
    oauth: codeArtsOAuth,
    callback: codeArtsCallback,
    refreshAuth: refreshCodeArts,
    refreshLeadMs: 30 * 60_000,
    discoverModels: discoverCodeArtsModels,
    fallbackModels: codeArtsFallbackModels,
    fetchQuota: fetchCodeArtsQuota,
  })
}
