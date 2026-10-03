import { randomUUID } from "node:crypto"
import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const mimoAccountCreation: ProviderAccountCreation = {
  prepare({ body, label }) {
    const settings = body.settings ?? {}
    const serviceToken = credentialString(
      body,
      "serviceToken",
      body.serviceToken
        ?? (typeof settings.serviceToken === "string" ?
          settings.serviceToken
        : undefined),
    )
    const xiaomichatbotPh = credentialString(
      body,
      "xiaomichatbotPh",
      body.xiaomichatbotPh
        ?? (typeof settings.xiaomichatbotPh === "string" ?
          settings.xiaomichatbotPh
        : undefined),
    )
    if (!serviceToken || !xiaomichatbotPh) {
      return { error: "Service Token and PH cookie are required." }
    }
    return {
      id: randomUUID(),
      name: label,
      provider: "mimo-aistudio",
      credentials: { serviceToken, xiaomichatbotPh },
      settings: {
        ...settings,
        userId:
          typeof settings.userId === "string" ? settings.userId : undefined,
        proxy: typeof settings.proxy === "string" ? settings.proxy : undefined,
      },
    }
  },
}
