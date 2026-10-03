import { randomUUID } from "node:crypto"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const windsurfAccountCreation: ProviderAccountCreation = {
  prepare({ body, label }) {
    const apiKey = credentialString(body, "apiKey", body.apiKey)
    if (!apiKey) return { error: "Windsurf API key is required." }
    return {
      id: randomUUID(),
      name: label,
      provider: "windsurf",
      credentials: { apiKey },
      settings: { ...body.settings },
    }
  },
}
