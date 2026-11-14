/**
 * Antigravity catalog variant collapse.
 *
 * Like Windsurf, Antigravity encodes thinking effort into the model id
 * itself: `fetchAvailableModels` fans one family out into per-tier SKUs
 * (`gemini-4-hydrogen-low`, `gemini-4-hydrogen-medium`, `claude-opus-5-5-high`,
 * `gpt-oss-120b-medium`, …). Collapse them into one listed head per family;
 * clients select the tier with `reasoning_effort` and dispatch resolves the
 * upstream id (see `resolveAntigravityRequestModel`).
 *
 * Unlike Windsurf, Antigravity also has a request-level thinkingConfig, so
 * families whose catalog ids carry no effort suffix (`gemini-2.5-flash`,
 * `gemini-3.1-flash-image`) stay plain mappings and keep translating
 * `reasoning_effort` into thinkingConfig as before.
 *
 * The provider-neutral mechanics (effort vocabulary, tier picker, head + pin
 * emission, dispatch resolution) live in `~/lib/effort-variants`; this file
 * keeps only Antigravity's catalog parsing and plain-vs-suffixed policy.
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

const ANTIGRAVITY_VARIANTS_METADATA_KEY = "antigravityVariants"

export interface RawAntigravityCatalogEntry {
  publicId: string
  name: string
  endpoints: Array<ModelEndpoint>
}

const EFFORT_SUFFIX = /(?:^|[-_])(minimal|low|medium|high|xhigh|none|max)$/i
const EFFORT_NAME_SUFFIX =
  /\s*\((minimal|low|medium|high|xhigh|none|max)\)\s*$/i

/** Peel a trailing effort token off a catalog id: family + effort tier. */
export function parseAntigravityVariantTokens(publicId: string): {
  family: string
  effort: EffortVariantKey | undefined
} {
  const match = EFFORT_SUFFIX.exec(publicId.trim())
  if (!match) return { family: publicId.trim(), effort: undefined }
  const family = publicId
    .trim()
    .slice(0, match.index)
    .replace(/[-_]+$/, "")
  if (!family) return { family: publicId.trim(), effort: undefined }
  return { family, effort: match[1].toLowerCase() as EffortVariantKey }
}

/** "Gemini 4 Hydrogen (Low)" → "Gemini 4 Hydrogen". */
function displayNameWithoutEffort(name: string): string {
  return name.replace(EFFORT_NAME_SUFFIX, "").trim() || name.trim()
}

/**
 * Collapse raw Antigravity catalog entries into:
 * - one listed head mapping per family that has effort-suffixed SKUs
 * - one `hidden: true` mapping per suffixed sibling, with its own upstreamId
 *
 * Families with no effort suffix at all pass through as plain mappings.
 */
export function collapseAntigravityModelVariants(
  entries: Array<RawAntigravityCatalogEntry>,
): Array<ModelMapping> {
  const groups = new Map<
    string,
    {
      family: string
      entries: Array<{
        entry: RawAntigravityCatalogEntry
        effort?: EffortVariantKey
      }>
      hasEffortAxis: boolean
    }
  >()

  for (const entry of entries) {
    if (!entry.publicId) continue
    const parsed = parseAntigravityVariantTokens(entry.publicId)
    let group = groups.get(parsed.family)
    if (!group) {
      group = { family: parsed.family, entries: [], hasEffortAxis: false }
      groups.set(parsed.family, group)
    }
    group.entries.push({ entry, effort: parsed.effort })
    if (parsed.effort !== undefined) group.hasEffortAxis = true
  }

  const mappings: Array<ModelMapping> = []

  for (const group of groups.values()) {
    const first = group.entries[0]
    if (!first) continue

    if (!group.hasEffortAxis) {
      mappings.push({
        publicId: first.entry.publicId,
        upstreamId: first.entry.publicId,
        name: first.entry.name,
        vendor: "antigravity",
        enabled: true,
        pickerEnabled: true,
        endpoints: first.entry.endpoints,
      })
      continue
    }

    const byEffort: Partial<Record<EffortVariantKey, string>> = {}
    for (const { entry, effort } of group.entries) {
      // A bare id alongside suffixed siblings is the family's default SKU;
      // it takes the `high` slot unless an explicit -high entry came first.
      const key = effort ?? "high"
      if (!byEffort[key]) byEffort[key] = entry.publicId
    }

    const defaultEffort = preferDefaultEffort(byEffort)
    const variants: EffortVariants = { defaultEffort, byEffort }
    const pins = group.entries
      .filter(
        ({ entry, effort }) =>
          effort !== undefined && entry.publicId !== group.family,
      )
      .map(({ entry }) => ({
        publicId: entry.publicId,
        upstreamId: entry.publicId,
        name: entry.name,
        vendor: "antigravity",
        endpoints: entry.endpoints,
      }))

    mappings.push(
      ...buildEffortVariantGroupMappings(
        ANTIGRAVITY_VARIANTS_METADATA_KEY,
        {
          publicId: group.family,
          upstreamId: byEffort[defaultEffort] ?? group.family,
          name: displayNameWithoutEffort(first.entry.name),
          vendor: "antigravity",
          pickerEnabled: true,
          endpoints: first.entry.endpoints,
          metadata: { [ANTIGRAVITY_VARIANTS_METADATA_KEY]: variants },
        },
        pins,
      ),
    )
  }

  mappings.sort((a, b) => a.publicId.localeCompare(b.publicId))
  return mappings
}

export function readAntigravityVariants(
  model: Pick<ModelMapping, "metadata"> | undefined,
): EffortVariants | undefined {
  return readEffortVariantsMetadata(model, ANTIGRAVITY_VARIANTS_METADATA_KEY)
}

/**
 * Client-facing `capabilities.supports.reasoning_effort` for a collapsed
 * head: exactly the effort keys this family actually has, default first
 * (see `listEffortVariants` for why the ordering is load-bearing).
 */
export function listAntigravitySupportedEfforts(
  model: Pick<ModelMapping, "metadata"> | undefined,
): Array<string> | undefined {
  return listEffortVariants(readAntigravityVariants(model))
}
