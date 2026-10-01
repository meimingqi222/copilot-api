/**
 * Resting: one read for "is this candidate sitting out, why, until when".
 *
 * A rest can live in three stores — the credential's own status/cooldown, a
 * (credential, model) cooldown, and the in-memory rest registry — and the one
 * helper must report each of them, agree with the outcomes availability and
 * target building already produce, and surface a held verify refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import {
  recordModelCooldown,
  resetModelCooldownsForTest,
} from "~/lib/model-cooldown"
import {
  __resetProviderConnectionsForTest,
  isCredentialAvailable,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  clearRestRegistryForTest,
  heldErrorFor,
  isResting,
  recordRest,
  restingReasonFor,
} from "~/lib/route-target"

import { setTestConnections } from "./helpers/set-connections"

const HALF_HOUR = 30 * 60_000

function credential(id: string): ApiCredential {
  return {
    id,
    authMode: "bearer",
    value: "sk-test",
    enabled: true,
    priority: 0,
    status: "ready",
    createdAt: Date.now(),
  }
}

/** A CodeBuddy-native connection, whose protocol opts into model cooldowns. */
function codebuddyConnection(
  id: string,
  models: Array<string>,
): ProviderConnection {
  const now = Date.now()
  return {
    id,
    name: id,
    protocol: "codebuddy-native",
    baseUrl: "https://example.test/v2",
    enabled: true,
    priority: 0,
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "access-token",
        enabled: true,
        status: "ready",
        createdAt: now,
      },
    ],
    models: models.map((model) => ({
      publicId: model,
      upstreamId: model,
      endpoints: ["chat"],
      enabled: true,
    })),
    createdAt: now,
    updatedAt: now,
  }
}

beforeEach(() => {
  clearRestRegistryForTest()
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
})

afterEach(() => {
  clearRestRegistryForTest()
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
  setTestConnections([])
})

describe("resting: model cooldown store", () => {
  test("a credential with only a model cooldown rests for that model", () => {
    recordModelCooldown({
      credentialId: "cool-cred",
      connectionId: "cool-conn",
      model: "model-a",
      untilMs: Date.now() + 60_000,
    })

    expect(isResting({ credentialId: "cool-cred", model: "model-a" })).toBe(
      true,
    )
    // The same credential's other models, and the account itself, are fine.
    expect(isResting({ credentialId: "cool-cred", model: "model-b" })).toBe(
      false,
    )
    expect(isResting({ credentialId: "cool-cred" })).toBe(false)
    expect(
      restingReasonFor({ credentialId: "cool-cred", model: "model-a" }),
    ).toMatchObject({ reason: "rate", by: "cooldown" })
  })

  test("an expired model cooldown is not a rest", async () => {
    recordModelCooldown({
      credentialId: "brief-cred",
      connectionId: "brief-conn",
      model: "model-a",
      untilMs: Date.now() + 1,
    })
    await Bun.sleep(10)
    expect(isResting({ credentialId: "brief-cred", model: "model-a" })).toBe(
      false,
    )
    expect(
      restingReasonFor({ credentialId: "brief-cred", model: "model-a" }),
    ).toBeUndefined()
  })

  test("target building agrees with the helper for a model cooldown", () => {
    setTestConnections([codebuddyConnection("cb1", ["model-a", "model-b"])])
    recordModelCooldown({
      credentialId: "cb1-cred",
      connectionId: "cb1",
      model: "model-a",
      untilMs: Date.now() + 60_000,
    })

    expect(isResting({ credentialId: "cb1-cred", model: "model-a" })).toBe(true)
    const cooled = buildRouteTargets({
      publicModelId: "model-a",
      endpoint: "chat",
    })
    expect(cooled.some((t) => t.connectionId === "cb1")).toBe(false)

    expect(isResting({ credentialId: "cb1-cred", model: "model-b" })).toBe(
      false,
    )
    const other = buildRouteTargets({
      publicModelId: "model-b",
      endpoint: "chat",
    })
    expect(other.some((t) => t.connectionId === "cb1")).toBe(true)
  })
})

describe("resting: registry rest", () => {
  test("a credential with only a registry rest rests", () => {
    const cred = credential("reg-cred")
    recordRest({
      credentialId: cred.id,
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + HALF_HOUR,
    })

    expect(
      isResting({
        credentialId: cred.id,
        credential: cred,
        credentialCreatedAt: cred.createdAt,
      }),
    ).toBe(true)
    // Availability agrees: the credential is skipped like a cooldown.
    expect(isCredentialAvailable(cred)).toBe(false)
  })

  test("a model-scoped registry rest rests only that model", () => {
    recordRest({
      credentialId: "reg-model-cred",
      model: "model-a",
      reason: "quota",
      by: "resets",
      untilMs: Date.now() + HALF_HOUR,
    })

    expect(
      isResting({ credentialId: "reg-model-cred", model: "model-a" }),
    ).toBe(true)
    expect(
      isResting({ credentialId: "reg-model-cred", model: "model-b" }),
    ).toBe(false)
    expect(isResting({ credentialId: "reg-model-cred" })).toBe(false)
  })

  test("when no rest is recorded the helper is quiet, as before", () => {
    const cred = credential("calm-cred")
    expect(
      isResting({
        credentialId: cred.id,
        credential: cred,
        credentialCreatedAt: cred.createdAt,
      }),
    ).toBe(false)
    expect(restingReasonFor({ credentialId: cred.id })).toBeUndefined()
    expect(isCredentialAvailable(cred)).toBe(true)

    setTestConnections([codebuddyConnection("calm-conn", ["model-a"])])
    expect(
      buildRouteTargets({ publicModelId: "model-a", endpoint: "chat" }).some(
        (t) => t.connectionId === "calm-conn",
      ),
    ).toBe(true)
  })
})

describe("resting: credential status", () => {
  test("a credential in cooldown rests at account scope", () => {
    const cred = credential("status-cred")
    cred.status = "cooldown"
    cred.cooldownUntil = Date.now() + HALF_HOUR

    expect(
      isResting({
        credentialId: cred.id,
        credential: cred,
        credentialCreatedAt: cred.createdAt,
      }),
    ).toBe(true)
    expect(
      restingReasonFor({ credentialId: cred.id, credential: cred }),
    ).toMatchObject({ reason: "rate", by: "cooldown" })
    expect(isCredentialAvailable(cred)).toBe(false)
  })

  test("the registry's richer rest wins over the coarse status", () => {
    const cred = credential("mixed-cred")
    cred.status = "cooldown"
    cred.cooldownUntil = Date.now() + HALF_HOUR
    recordRest({
      credentialId: cred.id,
      reason: "quota",
      by: "resets",
      untilMs: Date.now() + HALF_HOUR * 2,
    })

    expect(
      restingReasonFor({ credentialId: cred.id, credential: cred }),
    ).toMatchObject({ reason: "quota", by: "resets" })
  })
})

describe("resting: held verify refusal", () => {
  test("a held verify error surfaces from the one helper", () => {
    const now = Date.now()
    recordRest({
      credentialId: "verify-cred",
      reason: "verify",
      by: "verify",
      untilMs: now + HALF_HOUR,
      said: "VALIDATION_REQUIRED",
      now,
    })

    expect(heldErrorFor({ credentialId: "verify-cred" }, now + 1000)).toBe(
      "VALIDATION_REQUIRED",
    )
    // Past the short hold the vendor is asked again.
    expect(heldErrorFor({ credentialId: "verify-cred" }, now + 61_000)).toBe(
      undefined,
    )
  })
})
