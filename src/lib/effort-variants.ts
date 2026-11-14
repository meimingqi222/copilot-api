/**
 * Shared thinking-effort variant mechanics.
 *
 * Some upstreams (Windsurf, Antigravity) encode thinking effort into the
 * model id itself: one family fans out into per-tier SKUs (`glm-5-2-max`,
 * `gemini-4-hydrogen-low`, …). Both collapse those SKUs into one listed head
 * and let clients pick a tier with `reasoning_effort`.
 *
 * This module is the provider-neutral half of that mechanism (Strategy
 * pattern): the effort vocabulary, the tier picker, the variants projection,
 * the head + hidden-pin emission, and the connection-aware dispatch resolver.
 * Each provider keeps only what genuinely differs — its catalog parsing and
 * its collapse policy (Windsurf context tiers / latency lanes; Antigravity
 * plain-vs-suffixed families) — and delegates the rest here.
 *
 * The tier vocabulary itself lives in `~/lib/effort-levels`; this module sits
 * one layer above it, on the "catalog SKU per tier" shape.
 */

import type {
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { ReasoningEffort } from "~/lib/thinking"

import { logger } from "~/lib/logger"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

/** A discrete thinking tier a catalog SKU can carry. */
export type EffortVariantKey =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "none"
  | "max"

/** `max` is accepted as a discrete request tier alongside OpenAI levels. */
export type RequestedEffort = ReasoningEffort | "max"

/** effort key → upstream model id, plus the family's default tier. */
export interface EffortVariants {
  defaultEffort: EffortVariantKey
  byEffort: Partial<Record<EffortVariantKey, string>>
}

/** Default-tier preference: strongest standard tier first. */
const EFFORT_DEFAULT_ORDER: Array<EffortVariantKey> = [
  "high",
  "max",
  "xhigh",
  "medium",
  "low",
  "minimal",
  "none",
]

/** Ascending order for capabilities.supports.reasoning_effort. */
const EFFORT_LIST_ORDER: Array<EffortVariantKey> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/**
 * Thinking tiers ascending. `none` is deliberately absent: it turns thinking
 * off, so it is not a "lower" rung of the same ladder as minimal/low/.../max.
 * Used when a requested tier is missing and we must fall to the lowest tier
 * that still thinks, rather than to `none`.
 */
const THINKING_TIERS_ASCENDING: Array<EffortVariantKey> = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

export function preferDefaultEffort(
  available: Partial<Record<EffortVariantKey, string>>,
): EffortVariantKey {
  for (const candidate of EFFORT_DEFAULT_ORDER) {
    if (available[candidate]) return candidate
  }
  return "high"
}

/**
 * True when `requested` is a tier this family actually has. `undefined`/`auto`
 * mean "server decides" and are always considered satisfiable.
 */
export function effortVariantIsExact(
  requested: RequestedEffort | undefined | null,
  variants: EffortVariants,
): boolean {
  if (!requested || requested === "auto") return true
  return Boolean(variants.byEffort[requested])
}

/**
 * Map a client-facing reasoning_effort onto an available effort key.
 *
 * `max` and `xhigh` are independent tiers — never cross-map them. A catalog
 * that only has `max` (no `xhigh`) must not answer an `xhigh` request with
 * `max`, and vice versa. Missing tiers fall back to the family default.
 */
export function pickEffortVariant(
  requested: RequestedEffort | undefined | null,
  variants: EffortVariants,
): EffortVariantKey {
  const available = variants.byEffort
  const fallback = variants.defaultEffort

  if (!requested || requested === "auto") {
    return fallback
  }

  const has = (key: EffortVariantKey) => Boolean(available[key])

  if (requested === "none") {
    return has("none") ? "none" : fallback
  }
  if (requested === "minimal") {
    // `minimal` asks for the lightest *thinking* tier, not for thinking to be
    // switched off — the lowest available thinking tier, never `none` while a
    // thinking tier exists.
    if (has("minimal")) return "minimal"
    for (const key of THINKING_TIERS_ASCENDING) {
      if (has(key)) return key
    }
    return has("none") ? "none" : fallback
  }
  if (requested === "low") {
    if (has("low")) return "low"
    if (has("medium")) return "medium"
    if (has("high")) return "high"
    return fallback
  }
  if (requested === "medium") {
    if (has("medium")) return "medium"
    if (has("high")) return "high"
    if (has("low")) return "low"
    return fallback
  }
  if (requested === "high") {
    // Stay within the standard low/medium/high ladder — never promote to
    // `max` (that is a distinct SKU, not a higher high).
    if (has("high")) return "high"
    if (has("medium")) return "medium"
    if (has("low")) return "low"
    return fallback
  }
  if (requested === "xhigh") {
    return has("xhigh") ? "xhigh" : fallback
  }
  if (requested === "max") {
    return has("max") ? "max" : fallback
  }
  return fallback
}

/**
 * Client-facing `capabilities.supports.reasoning_effort` for a collapsed
 * head: exactly the effort keys this family actually has.
 *
 * The family default is emitted **first**; remaining tiers follow ascending.
 * This ordering is part of the contract, not cosmetic: consumers that receive
 * only a list of value strings (grok-build's `/effort` menu) treat the first
 * entry as the default, so a plain ascending list would silently make a
 * `{"none","high","max"}` family default to "no thinking".
 */
export function listEffortVariants(
  variants: EffortVariants | undefined,
): Array<string> | undefined {
  if (!variants) return undefined
  const present = EFFORT_LIST_ORDER.filter((key) => variants.byEffort[key])
  if (present.length === 0) return undefined
  if (!variants.byEffort[variants.defaultEffort]) return present
  return [
    variants.defaultEffort,
    ...present.filter((key) => key !== variants.defaultEffort),
  ]
}

/**
 * Resolve the upstream model id for a collapsed entry at a requested tier.
 * Falls back to the default tier, then to any present SKU.
 */
export function resolveEffortVariantUpstreamId(
  variants: EffortVariants,
  requestedEffort: RequestedEffort | undefined | null,
): string | undefined {
  const effortKey = pickEffortVariant(requestedEffort, variants)
  return (
    variants.byEffort[effortKey]
    ?? variants.byEffort[variants.defaultEffort]
    ?? Object.values(variants.byEffort)[0]
  )
}

/**
 * Read the base effort-variants record a provider stored under its metadata
 * key. Providers that carry extra axes (Windsurf context/lane) validate those
 * on top of this base read.
 */
export function readEffortVariantsMetadata(
  model: Pick<ModelMapping, "metadata"> | undefined,
  metadataKey: string,
): EffortVariants | undefined {
  const raw = model?.metadata?.[metadataKey]
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Partial<EffortVariants>
  if (
    !record.byEffort
    || typeof record.byEffort !== "object"
    || !record.defaultEffort
  ) {
    return undefined
  }
  return {
    defaultEffort: record.defaultEffort,
    byEffort: record.byEffort,
  }
}

/** A collapsed family head before the shared flags/efforts are attached. */
interface EffortVariantHead {
  publicId: string
  upstreamId: string
  name: string
  vendor: string
  pickerEnabled?: boolean
  pickerCategory?: string
  endpoints: Array<ModelEndpoint>
  metadata: Record<string, unknown>
}

/** A non-head sibling that stays routable by its own id, never listed. */
interface EffortVariantPin {
  publicId: string
  upstreamId: string
  name: string
  vendor: string
  pickerCategory?: string
  endpoints: Array<ModelEndpoint>
}

/**
 * Emit one collapsed group: the listed head (with its published effort list)
 * followed by a `hidden: true` mapping per non-head sibling. Each pin keeps
 * its own upstreamId so an explicit pin survives dispatch's payload.model
 * overwrite. Shared by every provider that collapses effort SKUs.
 */
export function buildEffortVariantGroupMappings(
  metadataKey: string,
  head: EffortVariantHead,
  pins: Array<EffortVariantPin>,
): Array<ModelMapping> {
  const variants = readEffortVariantsMetadata(
    { metadata: head.metadata },
    metadataKey,
  )
  const efforts = listEffortVariants(variants)
  const collapsed: ModelMapping = {
    ...head,
    enabled: true,
    pickerEnabled: head.pickerEnabled ?? true,
    // 折叠后这一族能接受的档位就是变体键；写进 mapping，让档位元信息跟
    // 其它 provider 走同一条投影/钳制路径。
    ...(efforts ? { efforts } : {}),
  }
  const pinMappings: Array<ModelMapping> = pins.map((pin) => ({
    ...pin,
    enabled: true,
    pickerEnabled: false,
    hidden: true,
  }))
  return [collapsed, ...pinMappings]
}

/**
 * Connection-aware dispatch resolution shared by effort-variant providers.
 *
 * Collapsed family heads select the tier with `reasoning_effort`; hidden pins
 * keep their own upstreamId (an explicit pin must not be re-selected); plain
 * models pass through. `formatUpstreamId` and `readVariants` are the
 * provider-specific hooks (e.g. Windsurf uppercases opaque `MODEL_*` ids).
 */
export function resolveEffortRequestModel(
  connection: ProviderConnection,
  modelId: string,
  effort: RequestedEffort | undefined | null,
  options: {
    readVariants: (model: ModelMapping) => EffortVariants | undefined
    formatUpstreamId: (upstreamId: string) => string
    logLabel: string
  },
): string {
  const { readVariants, formatUpstreamId, logLabel } = options
  const normalizedModelId = canonicalNativeModelId(modelId)
  const matchedModel = connection.models?.find((candidate) => {
    if (canonicalNativeModelId(candidate.publicId) === normalizedModelId) {
      return true
    }
    return (
      candidate.aliases?.some(
        (alias) => canonicalNativeModelId(alias) === normalizedModelId,
      ) ?? false
    )
  })

  if (!matchedModel) {
    return formatUpstreamId(modelId)
  }

  // Hidden variant mapping: publicId is already the pinned SKU. Do not
  // re-select by effort — that would defeat an explicit pin.
  if (matchedModel.hidden) {
    return formatUpstreamId(matchedModel.upstreamId)
  }

  const variants = readVariants(matchedModel)
  if (variants) {
    if (!effortVariantIsExact(effort, variants)) {
      logger.warn(
        `[${logLabel}] reasoning_effort not supported by this model`,
        {
          account: connection.name,
          model: matchedModel.publicId,
          requested: effort,
          applied: pickEffortVariant(effort, variants),
          supported: Object.keys(variants.byEffort),
        },
      )
    }
    return formatUpstreamId(
      resolveEffortVariantUpstreamId(variants, effort)
        ?? matchedModel.upstreamId,
    )
  }

  return formatUpstreamId(matchedModel.upstreamId)
}
