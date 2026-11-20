import { randomUUID } from "node:crypto"
import { HTTPError } from "~/lib/error"
import { asTrimmedString } from "~/lib/json-shape"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import { duMateNativeAdapter } from "~/services/dumate/adapter"
import {
  duMateConsoleGet,
  duMateGatewayToken,
  fetchDuMateQuota,
} from "~/services/dumate/client"
import {
  DUMATE_LOGIN_URL,
  duMateCatalog,
  duMateFallbackModels,
  importDuMateDesktopCookie,
  parseDuMateCookie,
} from "~/services/dumate/import"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import type { ProviderModule } from "~/services/providers/module"

const accountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    const source = body.credentials
    let cookie: string
    let catalog: Array<ModelMapping> | undefined
    try {
      const pasted = credentialString(body, "cookie", body.authToken)
      const key = asTrimmedString(source?.desktopCookieKeyBase64)
      cookie =
        pasted ? parseDuMateCookie(pasted)
        : key ? importDuMateDesktopCookie(source?.desktopAuth, key)
        : ""
      if (!cookie)
        return {
          error: `Sign in at ${DUMATE_LOGIN_URL}, then paste the console request Cookie.`,
        }
      if (source?.desktopModelConfig !== undefined)
        catalog = duMateCatalog(source.desktopModelConfig)
    } catch {
      return {
        error: "Invalid DuMate cookie, desktop login, or model catalog.",
      }
    }
    const proxyUrl = asTrimmedString(body.settings?.proxyUrl)
    try {
      await duMateConsoleGet("/api/dumate/user/info", cookie, { proxyUrl })
      await duMateGatewayToken(cookie, proxyUrl)
    } catch (error) {
      if (error instanceof HTTPError && error.response.status === 401) {
        return {
          error:
            "DuMate rejected the console session; sign in and copy a fresh Cookie.",
        }
      }
      return { error: "Could not validate the DuMate session.", status: 502 }
    }
    return {
      id: randomUUID(),
      name: label,
      provider: "dumate",
      credentials: { cookie, ...(catalog ? { dumateCatalog: catalog } : {}) },
      settings: { proxyUrl },
    }
  },
}

function discoverModels(
  connection: ProviderConnection,
): Promise<Array<ModelMapping>> {
  const stored = connection.credentials[0]?.context?.dumateCatalog
  const models = new Map(
    duMateFallbackModels().map((model) => [model.publicId, model]),
  )
  if (Array.isArray(stored)) {
    for (const model of stored as Array<ModelMapping>) {
      if (
        model?.vendor === "dumate"
        && typeof model.publicId === "string"
        && typeof model.upstreamId === "string"
      ) {
        models.set(model.publicId, { ...model, endpoints: ["chat"] })
      }
    }
  }
  return Promise.resolve([...models.values()])
}

const quota = { source: "poll" } as const

export function getDuMateModule(): ProviderModule {
  const descriptor = getProviderDescriptor("dumate")
  return {
    id: "dumate",
    descriptor,
    quota,
    accountCreation,
    adapter: duMateNativeAdapter,
    discoverModels,
    fetchQuota: fetchDuMateQuota,
    fallbackModels: duMateFallbackModels,
    createRuntime: () => ({
      id: "dumate",
      descriptor,
      quota,
      supports: (connection, feature) =>
        connection.protocol === "dumate-native"
        && descriptor.features.includes(feature),
      refreshModels: discoverModels,
      getFallbackModels: duMateFallbackModels,
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchDuMateQuota, signal, options),
      async refreshAuth(connection) {
        // Validate the source session; the gateway token is renewed lazily and never persisted.
        await duMateConsoleGet(
          "/api/dumate/user/info",
          connection.credentials[0]?.value ?? "",
          { proxyUrl: getConnectionProxyUrl(connection) },
        )
      },
    }),
  }
}
