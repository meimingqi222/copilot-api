import { createHash } from "node:crypto"

import { credentialString } from "~/services/providers/account-creation/helpers"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import {
  cookieInput,
  identifier,
  LingxiClient,
  LingxiError,
  WPS_ORIGINS,
  WPS_PATHS,
} from "~/services/wps-lingxi/client"

export const lingxiAccountCreation: ProviderAccountCreation = {
  async prepare({ body, label }) {
    const cookie = cookieInput(
      credentialString(body, "cookie", body.authToken) ?? "",
    )
    if (!cookie)
      return {
        error: "Paste a WPS wps_sid value or Cookie header containing wps_sid.",
      }
    const proxy = body.settings?.proxyUrl
    const options = {
      proxyUrl:
        typeof proxy === "string" ? proxy.trim() || undefined : undefined,
      signal: AbortSignal.timeout(20_000),
    }
    const profiles = await Promise.allSettled(
      WPS_ORIGINS.map(async (origin) => {
        const profile = await new LingxiClient(origin, cookie, options).json(
          WPS_PATHS.profile,
        )
        const identity = identifier(
          profile.id ?? profile.uid ?? profile.user_id,
        )
        const name = typeof profile.name === "string" ? profile.name.trim() : ""
        if (!identity && !name) throw new LingxiError(502, "missing_profile")
        return { origin, identity, name }
      }),
    )
    const winner = profiles.find((result) => result.status === "fulfilled")
    if (!winner) {
      const invalid = profiles.every(
        (result) =>
          result.status === "rejected"
          && result.reason instanceof LingxiError
          && [401, 403].includes(result.reason.response.status),
      )
      return {
        error:
          invalid ?
            "WPS Lingxi rejected this sign-in. Paste a current wps_sid."
          : "Could not verify WPS Lingxi sign-in at either official origin.",
        status: invalid ? 400 : 502,
      }
    }
    const { origin, identity, name } = winner.value
    const digest = createHash("sha256")
      .update(
        identity ? `uid:${identity}` : `cookie:${cookie.split(";", 1)[0]}`,
      )
      .digest("hex")
      .slice(0, 32)
    return {
      id: `wps-lingxi-${digest}`,
      name: body.label?.trim() || name || label,
      provider: "wps-lingxi",
      credentials: { cookie, origin },
      settings: { ...body.settings },
    }
  },
}
