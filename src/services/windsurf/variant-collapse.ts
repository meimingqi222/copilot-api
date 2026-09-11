/**
 * Windsurf catalog variant collapse.
 *
 * Upstream Windsurf encodes thinking effort (and sometimes context length
 * and latency lane) into the model id itself — there is no request-level
 * thinking parameter. A single family fans out into many catalog entries:
 *
 *   GLM-5.2 High              → glm-5-2
 *   GLM-5.2 Max               → glm-5-2-max
 *   GLM-5.2 No Thinking       → glm-5-2-none
 *   … × 1M context            → …-1m
 *   gpt-5.2-high-thinking     → effort high
 *   gpt-5.2-high-thinking-fast→ same effort, fast lane
 *
 * Collapse policy (plan C):
 * - Thinking effort is folded into one listed head per
 *   (family, context-tier, lane). Clients select effort via
 *   `reasoning_effort`. `max` and `xhigh` are independent tiers.
 * - Context (`1m`) and lane (`fast`/`priority`) stay separate public
 *   dimensions so pins keep their own upstreamId after dispatch overwrites
 *   payload.model.
 * - Non-head effort siblings become independent `hidden: true` mappings.
 */

import type { ModelEndpoint, ModelMapping } from "~/lib/provider-connections"
import type { ReasoningEffort } from "~/lib/thinking"

/** Windsurf accepts `max` as a discrete request tier alongside OpenAI levels. */
export type WindsurfRequestedEffort = ReasoningEffort | "max"

export type WindsurfEffortKey =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "none"
  /** Windsurf/GLM spelling for the top discrete tier. */
  | "max"

export type WindsurfContextTier = "standard" | "1m"

/** Latency/product lane. `fast`/`priority` are not thinking efforts. */
export type WindsurfLane = "standard" | "fast" | "priority"

export interface WindsurfModelVariants {
  contextTier: WindsurfContextTier
  lane: WindsurfLane
  defaultEffort: WindsurfEffortKey
  /** effort key → upstream model id */
  byEffort: Partial<Record<WindsurfEffortKey, string>>
}

export const WINDSURF_VARIANTS_METADATA_KEY = "windsurfVariants"

export interface RawWindsurfCatalogEntry {
  publicId: string
  name: string
  upstreamId: string
  vendor: string
  pickerEnabled?: boolean
  pickerCategory?: string
  endpoints: Array<ModelEndpoint>
  /** Optional baseModelId extracted from the Windsurf protobuf catalog. */
  baseModelId?: string
  baseDisplayName?: string
}

const EFFORT_ORDER: Array<WindsurfEffortKey> = [
  "high",
  "max",
  "xhigh",
  "medium",
  "low",
  "minimal",
  "none",
]

/** Ascending order for capabilities.supports.reasoning_effort. */
const LIST_EFFORT_ORDER: Array<WindsurfEffortKey> = [
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
const THINKING_TIERS_ASCENDING: Array<WindsurfEffortKey> = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/** Context window of the `1m` tier, as named by the upstream catalog. */
export const WINDSURF_1M_CONTEXT_TOKENS = 1_000_000

const CONTEXT_SUFFIX = /(?:^|[-_\s])1m$/i
const THINKING_SUFFIX = /(?:^|[-_\s])thinking$/i
const REASONING_SUFFIX = /(?:^|[-_\s])reasoning$/i
const EFFORT_TOKENS: Array<{
  token: RegExp
  key: WindsurfEffortKey
}> = [
  { token: /(?:^|[-_\s])no[-_\s]?thinking$/i, key: "none" },
  { token: /(?:^|[-_\s])none$/i, key: "none" },
  { token: /(?:^|[-_\s])disabled$/i, key: "none" },
  { token: /(?:^|[-_\s])minimal$/i, key: "minimal" },
  { token: /(?:^|[-_\s])low$/i, key: "low" },
  { token: /(?:^|[-_\s])medium$/i, key: "medium" },
  { token: /(?:^|[-_\s])high$/i, key: "high" },
  { token: /(?:^|[-_\s])xhigh$/i, key: "xhigh" },
  { token: /(?:^|[-_\s])max$/i, key: "max" },
]

const THINKING_OR_REASONING_SUFFIXES = [THINKING_SUFFIX, REASONING_SUFFIX]

function isOpaqueId(value: string): boolean {
  return /^model(?:_private)?_/i.test(value)
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[-_\s]+$/, "")
}

function detectEffortToken(value: string): WindsurfEffortKey | undefined {
  const trimmed = value.trim()
  for (const { token, key } of EFFORT_TOKENS) {
    if (token.test(trimmed)) return key
  }
  return undefined
}

function stripEffortToken(value: string): string {
  let result = value.trim()
  for (const { token } of EFFORT_TOKENS) {
    if (token.test(result)) {
      result = trimTrailingSeparators(result.replace(token, ""))
      break
    }
  }
  return result
}

export interface ParsedVariantTokens {
  family: string
  effort: WindsurfEffortKey | undefined
  contextTier: WindsurfContextTier
  lane: WindsurfLane
}

/**
 * Peel Windsurf catalog suffixes in order:
 *   family[-{effort}][-thinking][-fast|-priority][-1m]
 *
 * Lane tokens are only stripped when what remains still carries an effort
 * (or no-thinking) token — otherwise `swe-1-6-fast` would fold into
 * `swe-1-6`, which is a different product rather than a latency lane.
 */
export function parseWindsurfVariantTokens(
  publicId: string,
  displayName?: string,
): ParsedVariantTokens {
  // Prefer publicId (already slugified by extract); fall back to display name.
  let work = publicId.trim()
  if (!work || isOpaqueId(work)) {
    const fromName = (displayName ?? "")
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9.-]+/g, "-")
      .replaceAll(/-{2,}/g, "-")
      .replaceAll(/^-+|-+$/g, "")
    if (fromName && !isOpaqueId(fromName)) work = fromName
  }

  let contextTier: WindsurfContextTier = "standard"
  if (CONTEXT_SUFFIX.test(work)) {
    contextTier = "1m"
    work = trimTrailingSeparators(work.replace(CONTEXT_SUFFIX, ""))
  }

  let lane: WindsurfLane = "standard"
  // Priority/fast only when the remaining stem already looks like
  // family+effort (optionally with -thinking/-reasoning). Bare `*-fast`
  // product names are left intact.
  for (const laneToken of [
    { re: /(?:^|[-_\s])priority$/i, value: "priority" as const },
    { re: /(?:^|[-_\s])fast$/i, value: "fast" as const },
  ]) {
    if (!laneToken.re.test(work)) continue
    const stem = trimTrailingSeparators(work.replace(laneToken.re, ""))
    const stemIsEffortful =
      detectEffortToken(stem) !== undefined
      || THINKING_OR_REASONING_SUFFIXES.some(
        (suffix) =>
          suffix.test(stem)
          && detectEffortToken(trimTrailingSeparators(stem.replace(suffix, "")))
            !== undefined,
      )
    if (stemIsEffortful) {
      lane = laneToken.value
      work = stem
    }
  }

  // `{effort}-thinking` / `{effort}-reasoning` / `no-thinking` → effort.
  let effort: WindsurfEffortKey | undefined
  for (const wrapper of THINKING_OR_REASONING_SUFFIXES) {
    if (!wrapper.test(work)) continue
    const stem = trimTrailingSeparators(work.replace(wrapper, ""))
    const stemEffort = detectEffortToken(stem)
    if (stemEffort !== undefined) {
      effort = stemEffort
      work = stripEffortToken(stem)
      break
    }
    if (/(?:^|[-_\s])no$/i.test(stem)) {
      effort = "none"
      work = trimTrailingSeparators(stem.replace(/(?:^|[-_\s])no$/i, ""))
      break
    }
  }

  if (effort === undefined) {
    effort = detectEffortToken(work)
    if (effort !== undefined) {
      work = stripEffortToken(work)
    }
  }

  const family = work || publicId.trim()
  return { family, effort, contextTier, lane }
}

function preferDefaultEffort(
  available: Partial<Record<WindsurfEffortKey, string>>,
): WindsurfEffortKey {
  for (const candidate of EFFORT_ORDER) {
    if (available[candidate]) return candidate
  }
  return "high"
}

function displayNameWithoutVariantTokens(
  name: string,
  options: { keepThinking?: boolean } = {},
): string {
  // Keep the human-readable spelling; only peel known suffixes.
  let work = name.trim()
  work = work.replace(/\s*1M\s*$/i, "").trim()
  for (const laneRe of [/\s*Priority\s*$/i, /\s*Fast\s*$/i]) {
    const stem = work.replace(laneRe, "").trim()
    const stemParsed = parseWindsurfVariantTokens(
      stem.toLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-"),
    )
    if (stemParsed.effort !== undefined) {
      work = stem
    }
  }
  if (!options.keepThinking) {
    work = work.replace(/\s*Thinking\s*$/i, "").trim()
    work = work.replace(/\s*Reasoning\s*$/i, "").trim()
    work = work.replace(/\s*No\s*$/i, "").trim()
  }
  for (const effortRe of [
    /\s*Minimal\s*$/i,
    /\s*Low\s*$/i,
    /\s*Medium\s*$/i,
    /\s*High\s*$/i,
    /\s*XHigh\s*$/i,
    /\s*Max\s*$/i,
    /\s*None\s*$/i,
    /\s*Disabled\s*$/i,
  ]) {
    if (effortRe.test(work)) {
      work = work.replace(effortRe, "").trim()
      break
    }
  }
  return work || name.trim()
}

/**
 * Human-readable head name. Appends lane/context tags so sibling heads
 * (`… Fast`, `… Priority`, `… 1M`) never collide in /v1/models.
 * Thinking is only stripped when the family actually has an effort axis —
 * otherwise `claude-opus-4-6-thinking` would display as `Claude Opus 4.6`
 * and collide with the non-thinking SKU.
 */
function buildHeadDisplayName(group: VariantGroup): string {
  const hasEffortAxis =
    group.entries.length > 1
    || new Set(group.entries.map((e) => e.effort)).size > 1
  const rawName =
    group.baseDisplayName
    || group.entries[0]?.entry.name
    || groupPublicId(group)
  let display = displayNameWithoutVariantTokens(rawName, {
    keepThinking: !hasEffortAxis,
  })
  if (group.lane === "fast") display = `${display} Fast`
  else if (group.lane === "priority") display = `${display} Priority`
  if (group.contextTier === "1m") display = `${display} 1M`
  return display
}

interface VariantGroup {
  family: string
  contextTier: WindsurfContextTier
  lane: WindsurfLane
  entries: Array<{
    entry: RawWindsurfCatalogEntry
    effort: WindsurfEffortKey
  }>
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  endpoints: Array<ModelEndpoint>
  baseDisplayName?: string
}

function groupPublicId(group: VariantGroup): string {
  let id = group.family
  if (group.lane === "fast") id = `${id}-fast`
  else if (group.lane === "priority") id = `${id}-priority`
  if (group.contextTier === "1m") id = `${id}-1m`
  return id
}

/**
 * Collapse raw Windsurf catalog entries into:
 * - one listed head mapping per (family, context, lane)
 * - one `hidden: true` mapping per non-head sibling, with its own upstreamId
 */
export function collapseWindsurfModelVariants(
  entries: Array<RawWindsurfCatalogEntry>,
): Array<ModelMapping> {
  const groups = new Map<string, VariantGroup>()

  for (const entry of entries) {
    if (!entry.publicId) continue
    const parsed = parseWindsurfVariantTokens(entry.publicId, entry.name)
    const resolvedEffort: WindsurfEffortKey = parsed.effort ?? "high"
    const groupKey = `${parsed.family}::${parsed.contextTier}::${parsed.lane}`

    let group = groups.get(groupKey)
    if (!group) {
      group = {
        family: parsed.family,
        contextTier: parsed.contextTier,
        lane: parsed.lane,
        entries: [],
        vendor: entry.vendor,
        pickerEnabled: entry.pickerEnabled ?? true,
        pickerCategory: entry.pickerCategory,
        endpoints: entry.endpoints,
        baseDisplayName:
          entry.baseDisplayName ?
            displayNameWithoutVariantTokens(entry.baseDisplayName)
          : undefined,
      }
      groups.set(groupKey, group)
    } else if (entry.pickerCategory && !group.pickerCategory) {
      group.pickerCategory = entry.pickerCategory
    }

    group.entries.push({ entry, effort: resolvedEffort })
    if (entry.baseDisplayName && !group.baseDisplayName) {
      group.baseDisplayName = displayNameWithoutVariantTokens(
        entry.baseDisplayName,
      )
    }
  }

  const mappings: Array<ModelMapping> = []

  for (const group of groups.values()) {
    const byEffort: Partial<Record<WindsurfEffortKey, string>> = {}
    const entriesByPublicId = new Map<string, RawWindsurfCatalogEntry>()

    for (const { entry, effort } of group.entries) {
      const upstreamId = entry.upstreamId || entry.publicId
      if (!byEffort[effort]) {
        byEffort[effort] = upstreamId
      }
      if (!entriesByPublicId.has(entry.publicId)) {
        entriesByPublicId.set(entry.publicId, entry)
      }
    }

    const defaultEffort = preferDefaultEffort(byEffort)
    const publicId = groupPublicId(group)
    const upstreamId = byEffort[defaultEffort] ?? publicId
    const name = buildHeadDisplayName(group)

    const variants: WindsurfModelVariants = {
      contextTier: group.contextTier,
      lane: group.lane,
      defaultEffort,
      byEffort,
    }

    mappings.push({
      publicId,
      upstreamId,
      name,
      vendor: group.vendor,
      enabled: true,
      pickerEnabled: group.pickerEnabled,
      pickerCategory: group.pickerCategory,
      endpoints: group.endpoints,
      metadata: {
        [WINDSURF_VARIANTS_METADATA_KEY]: variants,
      },
    })

    for (const [legacyPublicId, entry] of entriesByPublicId) {
      if (legacyPublicId === publicId) continue
      mappings.push({
        publicId: legacyPublicId,
        upstreamId: entry.upstreamId || legacyPublicId,
        name: entry.name,
        vendor: entry.vendor,
        enabled: true,
        pickerEnabled: false,
        pickerCategory: entry.pickerCategory,
        endpoints: group.endpoints,
        hidden: true,
      })
    }
  }

  mappings.sort((a, b) => a.publicId.localeCompare(b.publicId))
  return mappings
}

export function readWindsurfVariants(
  model: Pick<ModelMapping, "metadata"> | undefined,
): WindsurfModelVariants | undefined {
  const raw = model?.metadata?.[WINDSURF_VARIANTS_METADATA_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Partial<WindsurfModelVariants>
  if (
    !record.byEffort
    || typeof record.byEffort !== "object"
    || !record.defaultEffort
    || !record.contextTier
  ) {
    return undefined
  }
  return {
    contextTier: record.contextTier,
    lane: record.lane ?? "standard",
    defaultEffort: record.defaultEffort,
    byEffort: record.byEffort,
  }
}

/**
 * Client-facing `capabilities.supports.reasoning_effort` for a collapsed
 * head: exactly the effort keys this family actually has. GLM-5.2 →
 * `["high","none","max"]`. Clients that honor this list will not send
 * unsupported tiers like `low`/`medium`/`xhigh`.
 *
 * The family default is emitted **first**; remaining tiers follow ascending.
 * This ordering is part of the contract, not cosmetic: consumers that receive
 * only a list of value strings (grok-build's `/effort` menu) treat the first
 * entry as the default, so a plain ascending list would silently make a
 * `{"none","high","max"}` family default to "no thinking".
 */
export function listWindsurfSupportedEfforts(
  model: Pick<ModelMapping, "metadata"> | undefined,
): Array<string> | undefined {
  const variants = readWindsurfVariants(model)
  if (!variants) return undefined
  const present = LIST_EFFORT_ORDER.filter((key) => variants.byEffort[key])
  if (present.length === 0) return undefined
  if (!variants.byEffort[variants.defaultEffort]) return present
  return [
    variants.defaultEffort,
    ...present.filter((key) => key !== variants.defaultEffort),
  ]
}

/**
 * Advertised context window for a collapsed head, or undefined when unknown.
 * Only the `1m` tier is knowable from the catalog naming; standard-tier
 * families carry no window information, so clients keep their own default
 * rather than being told a made-up number.
 */
export function windsurfContextWindow(
  model: Pick<ModelMapping, "metadata"> | undefined,
): number | undefined {
  const variants = readWindsurfVariants(model)
  if (!variants) return undefined
  return variants.contextTier === "1m" ? WINDSURF_1M_CONTEXT_TOKENS : undefined
}

/**
 * True when `requested` is a tier this family actually has. `undefined`/`auto`
 * mean "server decides" and are always considered satisfiable.
 */
export function windsurfEffortIsExact(
  requested: WindsurfRequestedEffort | undefined | null,
  variants: WindsurfModelVariants,
): boolean {
  if (!requested || requested === "auto") return true
  return Boolean(variants.byEffort[requested])
}

/**
 * Map a client-facing reasoning_effort onto an available Windsurf effort key.
 *
 * `max` and `xhigh` are independent tiers — never cross-map them. A catalog
 * that only has `max` (no `xhigh`) must not answer an `xhigh` request with
 * `max`, and vice versa. Missing tiers fall back to the family default.
 */
export function pickWindsurfEffort(
  requested: WindsurfRequestedEffort | undefined | null,
  variants: WindsurfModelVariants,
): WindsurfEffortKey {
  const available = variants.byEffort
  const fallback = variants.defaultEffort

  if (!requested || requested === "auto") {
    return fallback
  }

  const has = (key: WindsurfEffortKey) => Boolean(available[key])

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
    // Windsurf `max` (that is a distinct SKU, not a higher high).
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
 * Resolve the upstream model id for a collapsed Windsurf entry.
 * Returns undefined when the model has no variant metadata (uncollapsed).
 */
export function resolveWindsurfVariantUpstreamId(
  variants: WindsurfModelVariants,
  requestedEffort: WindsurfRequestedEffort | undefined | null,
): string | undefined {
  const effortKey = pickWindsurfEffort(requestedEffort, variants)
  return (
    variants.byEffort[effortKey]
    ?? variants.byEffort[variants.defaultEffort]
    ?? Object.values(variants.byEffort)[0]
  )
}
