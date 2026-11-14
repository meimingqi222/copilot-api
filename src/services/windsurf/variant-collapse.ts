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
 *
 * The provider-neutral mechanics (effort vocabulary, tier picker, head + pin
 * emission, dispatch resolution) live in `~/lib/effort-variants`; this file
 * keeps only Windsurf's catalog parsing and context/lane collapse policy.
 */

import type { ModelEndpoint, ModelMapping } from "~/lib/provider-connections"

import {
  buildEffortVariantGroupMappings,
  type EffortVariantKey,
  type EffortVariants,
  listEffortVariants,
  preferDefaultEffort,
  readEffortVariantsMetadata,
} from "~/lib/effort-variants"

type WindsurfContextTier = "standard" | "1m"

/** Latency/product lane. `fast`/`priority` are not thinking efforts. */
type WindsurfLane = "standard" | "fast" | "priority"

/** Windsurf adds context/lane axes on top of the shared effort variants. */
interface WindsurfModelVariants extends EffortVariants {
  contextTier: WindsurfContextTier
  lane: WindsurfLane
}

const WINDSURF_VARIANTS_METADATA_KEY = "windsurfVariants"

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

/** Context window of the `1m` tier, as named by the upstream catalog. */
export const WINDSURF_1M_CONTEXT_TOKENS = 1_000_000

const CONTEXT_SUFFIX = /(?:^|[-_\s])1m$/i
const THINKING_SUFFIX = /(?:^|[-_\s])thinking$/i
const REASONING_SUFFIX = /(?:^|[-_\s])reasoning$/i
const EFFORT_TOKENS: Array<{
  token: RegExp
  key: EffortVariantKey
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

function detectEffortToken(value: string): EffortVariantKey | undefined {
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

interface ParsedVariantTokens {
  family: string
  effort: EffortVariantKey | undefined
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
  let effort: EffortVariantKey | undefined
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
    effort: EffortVariantKey
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
    const resolvedEffort: EffortVariantKey = parsed.effort ?? "high"
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
    const byEffort: Partial<Record<EffortVariantKey, string>> = {}
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

    const pins = Array.from(entriesByPublicId.values())
      .filter((entry) => entry.publicId !== publicId)
      .map((entry) => ({
        publicId: entry.publicId,
        upstreamId: entry.upstreamId || entry.publicId,
        name: entry.name,
        vendor: entry.vendor,
        pickerCategory: entry.pickerCategory,
        endpoints: group.endpoints,
      }))

    mappings.push(
      ...buildEffortVariantGroupMappings(
        WINDSURF_VARIANTS_METADATA_KEY,
        {
          publicId,
          upstreamId,
          name,
          vendor: group.vendor,
          pickerEnabled: group.pickerEnabled,
          pickerCategory: group.pickerCategory,
          endpoints: group.endpoints,
          metadata: { [WINDSURF_VARIANTS_METADATA_KEY]: variants },
        },
        pins,
      ),
    )
  }

  mappings.sort((a, b) => a.publicId.localeCompare(b.publicId))
  return mappings
}

export function readWindsurfVariants(
  model: Pick<ModelMapping, "metadata"> | undefined,
): WindsurfModelVariants | undefined {
  const base = readEffortVariantsMetadata(model, WINDSURF_VARIANTS_METADATA_KEY)
  if (!base) return undefined
  const raw = model?.metadata?.[WINDSURF_VARIANTS_METADATA_KEY] as
    | Partial<WindsurfModelVariants>
    | undefined
  // Windsurf requires the context axis on top of the shared base record.
  if (!raw?.contextTier) return undefined
  return {
    ...base,
    contextTier: raw.contextTier,
    lane: raw.lane ?? "standard",
  }
}

/**
 * Client-facing `capabilities.supports.reasoning_effort` for a collapsed
 * head: exactly the effort keys this family actually has, default first
 * (see `listEffortVariants` for why the ordering is load-bearing).
 */
export function listWindsurfSupportedEfforts(
  model: Pick<ModelMapping, "metadata"> | undefined,
): Array<string> | undefined {
  return listEffortVariants(readWindsurfVariants(model))
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
