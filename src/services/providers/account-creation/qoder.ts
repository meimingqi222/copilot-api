import { randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import {
  exchangeQoderPersonalToken,
  fetchQoderUserInfo,
  qoderJobTokenLifetimeMs,
} from "~/services/oauth/qoder"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import type { QoderSite } from "~/services/qoder/endpoints"
import { newQoderMachineId } from "~/services/qoder/ids"

export function createQoderAccountCreation(
  site: QoderSite,
): ProviderAccountCreation {
  return {
    async prepare({ body, label }) {
      const pat = credentialString(body, "pat", body.authToken ?? body.apiKey)
      if (!pat)
        return { error: "Qoder Personal Access Token (pat) is required." }
      const proxy = body.settings?.proxyUrl
      const options = {
        proxyUrl: typeof proxy === "string" ? proxy : undefined,
      }
      try {
        const job = await exchangeQoderPersonalToken(pat, options, site)
        const user = await fetchQoderUserInfo(job.token, options, site)
        if (!user.id.trim())
          return {
            error: "Qoder PAT sign-in could not determine user id.",
            status: 502,
          }
        return {
          id: randomUUID(),
          name: label,
          provider: site.id,
          credentials: {
            accessToken: job.token,
            refreshToken: job.refreshToken,
            expiresAt: Date.now() + qoderJobTokenLifetimeMs(job),
            pat,
            uid: user.id,
            machineId: newQoderMachineId(),
            name: user.name,
            email: user.email,
            chatTokenKind: "job",
          },
          settings: { ...body.settings, baseUrl: site.apiHost },
          runtimeState: { authStatus: "ready" },
        }
      } catch (error) {
        const status = error instanceof HTTPError ? error.response.status : 0
        return {
          error:
            [400, 401, 403].includes(status) ?
              "Qoder refused the PAT; check it is still valid."
            : "Qoder PAT sign-in failed; retry later.",
          status: [400, 401, 403].includes(status) ? 400 : 502,
        }
      }
    },
  }
}
