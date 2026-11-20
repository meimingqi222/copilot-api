import { randomUUID } from "node:crypto"

import { extractJwtExpiryMs } from "~/services/oauth/jwt"
import { scheduleOAuthRefreshForConnection } from "~/services/oauth/refresh-scheduler"
import {
  applyFlowSettingsToConnection,
  createOAuthConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { raccoonNativeAdapter } from "~/services/protocols/raccoon-native"
import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import type { ProviderModule } from "~/services/providers/module"
import { defineOAuthProviderModule } from "~/services/providers/modules/define"
import {
  applyRaccoonTokens,
  raccoonCallback,
  raccoonIdentity,
  readRaccoonDesktopToken,
  renewRaccoonTokens,
  resolveRaccoonLogin,
  startRaccoonLogin,
} from "~/services/raccoon/auth"
import {
  discoverRaccoonModels,
  raccoonFallbackModels,
} from "~/services/raccoon/catalog"
import { fetchRaccoonQuota } from "~/services/raccoon/quota"

const strategy: OAuthProviderStrategy = {
  flowType: "callback",
  async start() {
    return startRaccoonLogin()
  },
  async exchange({ flow, code, signal }) {
    const connection = createOAuthConnection("raccoon", flow.label)
    applyFlowSettingsToConnection(connection, flow)
    applyRaccoonTokens(
      connection,
      await resolveRaccoonLogin(code ?? "", flow.state ?? "", {
        ...flowFetchOptions(flow),
        signal,
      }),
    )
    return connection
  },
}

export function getRaccoonModule(): ProviderModule {
  return defineOAuthProviderModule({
    id: "raccoon",
    adapter: raccoonNativeAdapter,
    oauth: strategy,
    callback: raccoonCallback,
    accountCreation: {
      async prepare({ body, label }) {
        if (body.credentials?.importDesktop !== true) {
          return {
            error:
              "Use Raccoon OAuth for browser or pasted credentials, or explicitly request importDesktop",
          }
        }
        try {
          const accessToken = await readRaccoonDesktopToken()
          if (accessToken) {
            return {
              id: randomUUID(),
              name: label,
              provider: "raccoon",
              settings: body.settings,
              credentials: {
                accessToken,
                accountId: raccoonIdentity(accessToken),
                expiresAt: extractJwtExpiryMs(accessToken),
              },
            }
          }
        } catch {
          return { error: "Raccoon desktop credentials could not be read" }
        }
        return {
          error: "No Raccoon desktop access token was found on the proxy host",
        }
      },
    },
    refreshAuth: prepareOAuthRefresh(renewRaccoonTokens),
    refreshLeadMs: 5 * 60_000,
    afterAuthentication: scheduleOAuthRefreshForConnection,
    discoverModels: discoverRaccoonModels,
    fallbackModels: raccoonFallbackModels,
    quota: { source: "poll" },
    fetchQuota: fetchRaccoonQuota,
  })
}
