import { randomUUID } from "node:crypto"
import {
  credentialString,
  extractJwtExp,
} from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const lobsteraiAccountCreation: ProviderAccountCreation = {
  prepare({ body, label }) {
    const accessToken = credentialString(body, "accessToken", body.authToken)
    const refreshToken = credentialString(body, "refreshToken")
    if (!accessToken && !refreshToken) {
      return { error: "LobsterAI accessToken or refreshToken is required." }
    }
    const expiresAt = accessToken ? extractJwtExp(accessToken) : undefined
    const credentials: Record<string, unknown> = {
      accessToken: accessToken ?? "",
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }
    for (const key of ["uuid", "userId", "firstKeyfrom", "latestKeyfrom"]) {
      const value = credentialString(body, key)
      if (value) credentials[key] = value
    }
    return {
      id: randomUUID(),
      name: label,
      provider: "lobsterai",
      credentials,
      settings: { ...body.settings },
    }
  },
}
