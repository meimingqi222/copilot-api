import { randomUUID } from "node:crypto"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import {
  fetchWindsurfSelfProfile,
  readWindsurfCliCredentials,
} from "~/services/oauth/windsurf"

export const windsurfAccountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    const importCli =
      body.credentials?.importCli === true || body.settings?.importCli === true
    let imported:
      | Awaited<ReturnType<typeof readWindsurfCliCredentials>>
      | undefined
    if (importCli) {
      try {
        imported = await readWindsurfCliCredentials()
      } catch {
        return {
          error:
            "Could not read the server's Devin CLI credentials.toml. Sign in with the CLI on this server first.",
        }
      }
    }
    const apiKey =
      imported?.sessionToken ?? credentialString(body, "apiKey", body.apiKey)
    if (!apiKey) return { error: "Windsurf API key is required." }
    let profile: Awaited<ReturnType<typeof fetchWindsurfSelfProfile>>
    try {
      profile = await fetchWindsurfSelfProfile(
        apiKey,
        {
          proxyUrl:
            typeof body.settings?.proxyUrl === "string" ?
              body.settings.proxyUrl
            : undefined,
        },
        imported?.baseUrl
          ?? (typeof body.settings?.baseUrl === "string" ?
            body.settings.baseUrl
          : undefined),
      )
    } catch {
      return { error: "Devin rejected the credential.", status: 400 }
    }
    const settings = { ...body.settings }
    delete settings.importCli
    return {
      id: randomUUID(),
      name: body.label?.trim() || profile.userName || label,
      provider: "windsurf",
      credentials: {
        apiKey,
        email: profile.email,
        accountId: profile.userId,
        organizationId: profile.orgId,
      },
      settings: {
        ...settings,
        ...(imported ?
          {
            baseUrl: imported.baseUrl,
            devinWebappHost: imported.devinWebappHost,
            devinApiUrl: imported.devinApiUrl,
          }
        : {}),
      },
    }
  },
}
