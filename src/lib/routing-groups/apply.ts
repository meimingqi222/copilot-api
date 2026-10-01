/**
 * Applying a group member's suffixes to the outgoing request.
 *
 * A member may be written `vendor/model:high:fast`. The `:high` and `:fast` are
 * routing vocabulary, not part of the model id (`member.ts` strips them before
 * the id reaches route-target selection), so somebody has to turn them back
 * into request fields or they are silently dropped: a group that says "serve
 * this at high effort, fast lane" would route to the right model and then ask
 * it the same way as any other request.
 *
 * This module is that translation, and only that translation. It mutates the
 * payload object it is handed — the same object every route passes to dispatch
 * as `sessionPayload` — and reports what it wrote, so the caller can surface it
 * on the trace. A payload that is not an object, or an endpoint whose wire has
 * no such field (Gemini, embeddings), is left exactly as it was.
 *
 * The two field spellings are the ones the repo already uses:
 * - `reasoning_effort` for the chat / messages wire, `reasoning.effort` for the
 *   responses wire (see `routes/responses/handler.ts`);
 * - `service_tier: "priority"` for the fast lane — the only service tier the
 *   codex path keeps (`services/codex/upstream-body.ts`) and one Anthropic
 *   reports back as a usage tier.
 */

import type { ModelEndpoint } from "~/lib/provider-connections"

import { isEffortLevel } from "./types"

/** The service tier a `:fast` member asks for. */
export const FAST_SERVICE_TIER = "priority"

/** What a member's suffixes ask for, as `resolve.ts` reads them. */
interface GroupOverrides {
  /** Reasoning level the member carries, if any. */
  effort?: string
  /** The member asked for its fast variant. */
  fast?: boolean
}

/** What of a member's suffixes actually reached the payload. */
export interface AppliedGroupOverrides {
  /** Effort written, when the member asked for one and the wire takes it. */
  effort?: string
  /** The fast lane was requested and the wire takes it. */
  fast: boolean
  /** Payload field the effort went to, for the request log. */
  effortField?: string
  /** Payload field the fast lane went to, for the request log. */
  fastField?: string
}

interface ApplyGroupOverridesOptions {
  /** Endpoint the payload is written for; decides which spellings apply. */
  endpoint?: ModelEndpoint
  baseline?: GroupOverrideBaseline
}

const OVERRIDE_FIELDS = [
  "reasoning_effort",
  "reasoning",
  "service_tier",
] as const
export type GroupOverrideBaseline = Partial<
  Record<(typeof OVERRIDE_FIELDS)[number], unknown>
>

/** Preserve the caller's fields so a retry does not inherit another member's suffixes. */
export function captureGroupOverrideBaseline(
  payload: unknown,
): GroupOverrideBaseline {
  const record = asRecord(payload)
  const baseline: GroupOverrideBaseline = {}
  if (!record) return baseline
  for (const key of OVERRIDE_FIELDS) {
    if (Object.hasOwn(record, key)) {
      baseline[key] =
        asRecord(record[key]) ? { ...asRecord(record[key]) } : record[key]
    }
  }
  return baseline
}

/**
 * Whether the wire behind `endpoint` carries a reasoning effort at all.
 * Gemini expresses thinking as a budget, not an effort string, and embeddings
 * has no reasoning, so neither is guessed at here.
 */
function carriesEffort(endpoint: ModelEndpoint | undefined): boolean {
  return (
    endpoint === undefined
    || endpoint === "chat"
    || endpoint === "messages"
    || endpoint === "responses"
  )
}

/** Whether the wire behind `endpoint` carries a service tier. */
function carriesServiceTier(endpoint: ModelEndpoint | undefined): boolean {
  return carriesEffort(endpoint)
}

/** The payload as a mutable record, or undefined when it is not one. */
function asRecord(payload: unknown): Record<string, unknown> | undefined {
  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    return undefined
  }
  return payload as Record<string, unknown>
}

/**
 * Write `overrides` onto `payload`, returning what was written.
 *
 * Never throws and never half-applies: an unknown effort word is ignored
 * (the member parser only yields known levels, so this is a guard, not a
 * feature), and an endpoint that cannot express a field simply does not get it.
 * The returned object always reports `fast`, so a caller can tell "the member
 * asked and it was applied" from "the member did not ask".
 */
export function applyGroupOverrides(
  payload: unknown,
  overrides: GroupOverrides,
  options: ApplyGroupOverridesOptions = {},
): AppliedGroupOverrides {
  const applied: AppliedGroupOverrides = { fast: false }
  const record = asRecord(payload)
  if (!record) return applied

  if (options.baseline) {
    for (const key of OVERRIDE_FIELDS) {
      if (Object.hasOwn(options.baseline, key)) {
        const original = options.baseline[key]
        record[key] = asRecord(original) ? { ...asRecord(original) } : original
      } else delete record[key]
    }
  }

  const { endpoint } = options

  const effort =
    typeof overrides.effort === "string" ?
      overrides.effort.trim().toLowerCase()
    : ""
  if (effort !== "" && isEffortLevel(effort) && carriesEffort(endpoint)) {
    if (endpoint === "responses") {
      // Preserve whatever else the request put there (`summary`, …).
      const reasoning = asRecord(record["reasoning"]) ?? {}
      reasoning["effort"] = effort
      record["reasoning"] = reasoning
      applied.effort = effort
      applied.effortField = "reasoning.effort"
    } else {
      record["reasoning_effort"] = effort
      applied.effort = effort
      applied.effortField = "reasoning_effort"
    }
  }

  if (overrides.fast === true && carriesServiceTier(endpoint)) {
    record["service_tier"] = FAST_SERVICE_TIER
    applied.fast = true
    applied.fastField = "service_tier"
  }

  return applied
}
