import { isRecord } from "~/lib/json-shape"
import type {
  QuotaAllowance,
  QuotaSnapshot,
  QuotaWindow,
} from "~/lib/quota/types"

const units = new Set([
  "percent",
  "requests",
  "tokens",
  "credits",
  "currency",
  "units",
])

export function normalizeQuotaWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const out: QuotaWindow = {}
  if (typeof value.id === "string" && value.id) out.id = value.id
  for (const key of [
    "used",
    "remaining",
    "total",
    "spanMs",
    "resetsAtMs",
    "expiresAtMs",
  ] as const) {
    const n = value[key]
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue
    if (key === "used") out.used = Math.min(n, 1)
    else if (key === "remaining" || n > 0) out[key] = n
  }
  if (typeof value.unit === "string" && units.has(value.unit))
    out.unit = value.unit as QuotaWindow["unit"]
  if (value.scope !== undefined) {
    // Malformed scope must never widen a local pool to the whole account.
    out.scope = {
      models:
        isRecord(value.scope) && Array.isArray(value.scope.models) ?
          value.scope.models.filter((m): m is string => typeof m === "string")
        : [],
    }
  }
  if (typeof value.model === "string") out.model = value.model
  if (value.aside === true) out.aside = true
  if (value.unlimited === true) out.unlimited = true
  if (
    out.used === undefined
    && out.remaining !== undefined
    && out.total !== undefined
  ) {
    out.used = Math.max(0, Math.min(1, 1 - out.remaining / out.total))
  }
  return (
      out.used !== undefined
        || out.remaining !== undefined
        || out.resetsAtMs !== undefined
        || out.expiresAtMs !== undefined
        || out.unlimited
    ) ?
      out
    : undefined
}

export function normalizeQuotaAllowance(value: QuotaAllowance): QuotaAllowance {
  return {
    ...value,
    windows: value.windows
      .map(normalizeQuotaWindow)
      .filter((w): w is QuotaWindow => w !== undefined),
  }
}

/** No provider names, labels, currencies or model-family guesses here. */
export function quotaWindowApplies(
  window: QuotaWindow,
  model?: string,
): boolean {
  if (window.aside) return false
  if (window.scope)
    return model !== undefined && window.scope.models.includes(model)
  const legacyScope = window.model?.trim().toLowerCase()
  if (legacyScope) return !model || model.toLowerCase().includes(legacyScope)
  return true
}

export function quotaAvailability(
  snapshot: QuotaSnapshot,
  model?: string,
  now = Date.now(),
): "available" | "exhausted" | "unknown" {
  const allowance = snapshot.allowance
  if (!allowance) return "unknown"
  if (allowance.state === "unlimited") return "available"
  if (allowance.state === "not-included") return "exhausted"
  if (allowance.state !== "known") return "unknown"
  let known = false
  for (const window of allowance.windows) {
    if (!quotaWindowApplies(window, model)) continue
    if (window.unlimited) {
      known = true
      continue
    }
    if (window.expiresAtMs !== undefined && window.expiresAtMs <= now)
      return "exhausted"
    // A passed reset permits a probe, but is not a new successful reading.
    if (window.resetsAtMs !== undefined && window.resetsAtMs <= now) continue
    if (window.remaining !== undefined) {
      if (window.remaining <= 0) return "exhausted"
      known = true
    } else if (window.used !== undefined) {
      if (window.used >= 1) return "exhausted"
      known = true
    }
  }
  return known ? "available" : "unknown"
}

/** Keep the frozen admin quota DTO independent of internal routing semantics. */
export function publicQuotaSnapshot(
  snapshot: QuotaSnapshot | undefined,
): Omit<QuotaSnapshot, "allowance"> | undefined {
  if (!snapshot) return undefined
  const { allowance: _allowance, ...publicSnapshot } = snapshot
  return publicSnapshot
}
