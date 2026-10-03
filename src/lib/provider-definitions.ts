import { PROVIDER_METADATA } from "~/lib/provider-metadata"

/** Identity and protocol data derive from the same pure contributions as the UI. */
export const PROVIDER_DEFINITIONS = PROVIDER_METADATA

export type ProviderId = keyof typeof PROVIDER_DEFINITIONS
export type NativeProviderProtocol =
  (typeof PROVIDER_DEFINITIONS)[ProviderId]["protocol"]
export type OAuthProviderId = {
  [K in ProviderId]: (typeof PROVIDER_DEFINITIONS)[K]["oauth"] extends true ? K
  : never
}[ProviderId]

export const PROVIDER_IDS = Object.keys(
  PROVIDER_DEFINITIONS,
) as Array<ProviderId>
export const OAUTH_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id): id is OAuthProviderId => PROVIDER_DEFINITIONS[id].oauth,
)
export const PROVIDER_PROTOCOL_MAP = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, PROVIDER_DEFINITIONS[id].protocol]),
) as Record<ProviderId, NativeProviderProtocol>
