import { randomUUID } from "node:crypto"

import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { cookieHeader, parseCookieHeader } from "~/services/aistudio/auth"
import { aistudioNativeAdapter } from "~/services/protocols/aistudio-native"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderModule } from "~/services/providers/module"

export function getAIStudioModule(): ProviderModule {
  const descriptor = getProviderDescriptor("aistudio")
  return {
    id: "aistudio",
    descriptor,
    adapter: aistudioNativeAdapter,
    accountCreation: {
      prepare({ body, label }) {
        try {
          const cookie = cookieHeader(
            parseCookieHeader(credentialString(body, "cookie") ?? ""),
          )
          return {
            id: randomUUID(),
            name: label,
            provider: "aistudio",
            credentials: { cookie },
            settings: body.settings,
          }
        } catch (error) {
          return {
            error:
              error instanceof Error ?
                error.message
              : "Invalid AI Studio Cookie.",
          }
        }
      },
    },
    createRuntime: () => ({
      id: "aistudio",
      descriptor,
      supports: (_connection, feature) => descriptor.features.includes(feature),
      async refreshModels(connection) {
        const credential = connection.credentials.find((item) => item.enabled)
        if (!credential) return []
        return aistudioNativeAdapter.discoverModels!({ connection, credential })
      },
    }),
  }
}
