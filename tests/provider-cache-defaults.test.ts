import { expect, test } from "bun:test"
import { CACHE_UTILIZATION_DEFAULTS } from "~/lib/routing/provider-cache"
import {
  PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
  PROTOCOL_PROVIDER_MAP,
} from "~/lib/provider-definitions"
import { providerFromProtocol } from "~/lib/provider-connections/protocol-provider"

test("shared routing defaults require no registration for each new provider", () => {
  expect(CACHE_UTILIZATION_DEFAULTS.strategy).toBe("quota")
  expect(CACHE_UTILIZATION_DEFAULTS.sessionAffinity).toBe(true)
  expect(CACHE_UTILIZATION_DEFAULTS.identityConfuse).toBe(false)
})

test("all provider protocols share one reverse lookup with deterministic alias precedence", () => {
  for (const provider of PROVIDER_IDS) {
    const protocol = PROVIDER_PROTOCOL_MAP[provider]
    const expected = PROVIDER_IDS.filter(
      (id) => PROVIDER_PROTOCOL_MAP[id] === protocol,
    ).at(-1)
    expect(PROTOCOL_PROVIDER_MAP[protocol]).toBe(expected)
    expect(providerFromProtocol(protocol)).toBe(expected)
  }
  expect(providerFromProtocol("openai-compatible")).toBeUndefined()
})
