import { randomUUID } from "node:crypto"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const codebuffAccountCreation: ProviderAccountCreation = {
  prepare({ body, label }) {
    const authToken = credentialString(body, "authToken", body.authToken)
    if (!authToken) return { error: "Codebuff auth token is required." }
    return {
      id: randomUUID(),
      name: label,
      provider: "codebuff",
      credentials: { authToken },
      settings: { ...body.settings },
    }
  },
}
