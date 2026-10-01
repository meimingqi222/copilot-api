// Resting: one read for "is this candidate sitting out, why, and until when".
//
// A candidate's rest has three stores behind it, and each used to be read
// where it was needed: the credential's own `status` / `cooldownUntil`
// (persisted with the connection), a `(credential, model)` cooldown (a
// provider's model-level rate limit), and the rest registry — the richer,
// in-memory side that carries `by` / `failures` / a verify link. This module
// is the single place that reads all three, so availability, target building
// and the trace view cannot drift apart on what "resting" means.
//
// The query's scope decides which stores answer:
//
// - Account scope (no `model`): the credential's own status/cooldown and the
//   registry's rest for the credential.
// - Model scope (`model` set): the registry's rest for that (credential,
//   model) and the model-cooldown store. The account-wide question is asked
//   separately by `isCredentialAvailable`, so a candidate is never weighed
//   twice for its own status.
//
// `restingReasonFor` reports the richest rest, live or lapsed — the registry
// keeps a lapsed entry so a trace can still name why a candidate sat out —
// while `isResting` is the live gate: a lapsed entry is not a rest.

import { getModelCooldownRemainingMs } from "~/lib/model-cooldown"

import type { ApiCredential } from "~/lib/provider-connections"

import { restInfoFor, verifyHeldError } from "./rest-registry"
import { restInfoForCredential, type RestInfo } from "./rest-reason"

/** What to ask about: one credential, optionally scoped to one model. */
export interface RestingQuery {
  /** Credential the question is about; keys the registry and model cooldowns. */
  credentialId: string
  /**
   * The credential instance, when the caller has it. Its persisted
   * `status`/`cooldownUntil` answer the account-scope question; a caller that
   * already weighed account availability (a model-scoped check) may omit it.
   */
  credential?: ApiCredential
  /**
   * Model the question is scoped to. Omitted asks the account-wide question; a
   * set model asks only about rests scoped to it, so a (credential, model)
   * pair can be weighed without hiding the credential itself.
   */
  model?: string
  /**
   * `createdAt` of the credential instance, so a registry rest binds to the
   * instance that took it. Callers that have always matched a rest by id alone
   * (the trace view) leave it out, and every existing entry keeps applying.
   */
  credentialCreatedAt?: number
}

/**
 * A live `(credential, model)` cooldown, as the rest it is. A model cooldown
 * is a rate rest by construction: the provider rate-limited that one model
 * while the account itself stayed healthy.
 */
function modelCooldownRest(
  credentialId: string,
  model: string,
  now: number,
): RestInfo | undefined {
  const remaining = getModelCooldownRemainingMs(credentialId, model)
  if (remaining <= 0) return undefined
  return {
    reason: "rate",
    by: "cooldown",
    untilMs: now + remaining,
    retryAfterMs: remaining,
  }
}

/** Every store the query's scope weighs, read once. */
interface RestingReads {
  /** Registry rest for the scope (live or lapsed), when one is recorded. */
  registry?: RestInfo
  /** A live model-cooldown rest; model scope only. */
  modelCooldown?: RestInfo
  /** The credential's own rest (status !== "ready"); account scope only. */
  credentialStatus?: RestInfo
}

function readResting(query: RestingQuery, now: number): RestingReads {
  const registry = restInfoFor(
    query.credentialId,
    query.model,
    query.credentialCreatedAt,
  )
  if (query.model) {
    return {
      registry,
      modelCooldown: modelCooldownRest(query.credentialId, query.model, now),
    }
  }
  return { registry, credentialStatus: restInfoForCredential(query.credential) }
}

/** The richest rest for the query's scope, live or lapsed, when there is one. */
export function restingReasonFor(query: RestingQuery): RestInfo | undefined {
  const reads = readResting(query, Date.now())
  return reads.registry ?? reads.modelCooldown ?? reads.credentialStatus
}

/** Whether the query's scope is sitting out right now. */
export function isResting(query: RestingQuery): boolean {
  const reads = readResting(query, Date.now())
  if (reads.registry?.untilMs !== undefined) return true
  if (reads.modelCooldown !== undefined) return true
  return reads.credentialStatus !== undefined
}

/**
 * The vendor's own refusal text, answered from memory for a candidate its
 * vendor asked to verify a moment ago — so an agent's reconnects don't all
 * land on an account the vendor has stopped. The hold lapses on its own; past
 * it the vendor is asked again.
 */
export function heldErrorFor(
  query: RestingQuery,
  now?: number,
): string | undefined {
  return verifyHeldError(
    query.credentialId,
    query.model,
    now,
    query.credentialCreatedAt,
  )
}
