import { describe, expect, test } from "bun:test"

import {
  OAUTH_PROVIDER_IDS,
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
  type NativeProviderProtocol,
  type OAuthProviderId,
  type ProviderId,
} from "~/lib/provider-definitions"
import {
  getProviderDescriptor,
  PROVIDER_DESCRIPTORS,
} from "~/lib/provider-descriptors"
import {
  createProviderMetadataCatalog,
  defineProviderMetadata,
} from "~/lib/provider-descriptors/metadata"
import {
  PROVIDER_METADATA,
  PROVIDER_METADATA_ENTRIES,
} from "~/lib/provider-metadata"

describe("pure provider metadata", () => {
  test("identity, protocol, OAuth classification and UI derive from each contribution", () => {
    expect(PROVIDER_IDS).toEqual(
      PROVIDER_METADATA_ENTRIES.map((m) => m.descriptor.id),
    )
    expect(Object.keys(PROVIDER_DESCRIPTORS)).toEqual(PROVIDER_IDS)
    for (const entry of PROVIDER_METADATA_ENTRIES) {
      const id = entry.descriptor.id
      expect(PROVIDER_DEFINITIONS[id]).toBe(entry)
      expect(PROVIDER_PROTOCOL_MAP[id]).toBe(entry.protocol)
      expect(OAUTH_PROVIDER_IDS.includes(id as OAuthProviderId)).toBe(
        entry.oauth,
      )
      expect(getProviderDescriptor(id)).toBe(entry.descriptor)
      expect(getProviderDescriptor(id)).not.toHaveProperty("protocol")
      expect(getProviderDescriptor(id)).not.toHaveProperty("planBased")
    }
  })

  test("a new contribution preserves literal identity without a separate ID or protocol table", () => {
    const example = defineProviderMetadata({
      protocol: "example-native",
      oauth: true,
      descriptor: {
        id: "example",
        name: "Example",
        icon: "example",
        authMode: "oauth",
        accountFields: [],
        features: ["oauth"],
      },
    })
    const catalog = createProviderMetadataCatalog([example])
    const id: "example" = catalog.example.descriptor.id
    const protocol: "example-native" = catalog.example.protocol
    const oauth: true = catalog.example.oauth
    expect([id, protocol, oauth]).toEqual(["example", "example-native", true])

    const existingId: ProviderId = "copilot"
    const existingProtocol: NativeProviderProtocol = "codebuddy-native"
    const existingOAuth: OAuthProviderId = "codex"
    // @ts-expect-error The identity union must remain closed, not widen to string.
    const invalidId: ProviderId = "example"
    // @ts-expect-error Direct account classification must remain excluded from OAuthProviderId.
    const directId: OAuthProviderId = "copilot"
    expect([existingId, existingProtocol, existingOAuth]).toEqual([
      "copilot",
      "codebuddy-native",
      "codex",
    ])
    expect(String(invalidId)).toBe("example")
    expect(String(directId)).toBe("copilot")
  })

  test("duplicate IDs fail clearly while shared protocols remain supported", () => {
    const first = PROVIDER_METADATA.codebuddy
    expect(() => createProviderMetadataCatalog([first, first])).toThrow(
      "Duplicate provider metadata: codebuddy",
    )
    const regional = PROVIDER_METADATA["codebuddy-cn"]
    const catalog = createProviderMetadataCatalog([first, regional])
    expect(Object.keys(catalog)).toEqual(["codebuddy", "codebuddy-cn"])
    expect(catalog.codebuddy.protocol).toBe(catalog["codebuddy-cn"].protocol)
    expect(PROVIDER_METADATA["commandcode-plan"].planBased).toBe(true)
  })
})
