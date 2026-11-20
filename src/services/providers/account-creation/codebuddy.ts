import { randomUUID } from "node:crypto"
import {
  credentialString,
  extractJwtExp,
} from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export function createCodebuddyAccountCreation(
  provider: "codebuddy" | "codebuddy-cn",
): ProviderAccountCreation {
  return {
    prepare({ body, label }) {
      const apiKey = credentialString(body, "apiKey", body.apiKey)
      const accessToken = credentialString(body, "accessToken", body.authToken)
      const refreshToken = credentialString(body, "refreshToken")
      if (apiKey) {
        if (accessToken || refreshToken) {
          return {
            error: "Supply a WorkBuddy API key or account tokens, not both.",
          }
        }
        return {
          id: randomUUID(),
          name: label,
          provider,
          credentials: { accessToken: apiKey, signIn: "api-key" },
          settings: { ...body.settings },
        }
      }
      if (!accessToken) {
        return {
          error: "CodeBuddy accessToken or WorkBuddy apiKey is required.",
        }
      }
      const expiresAt = extractJwtExp(accessToken)
      return {
        id: randomUUID(),
        name: label,
        provider,
        credentials: {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        },
        settings: { ...body.settings },
      }
    },
  }
}
