import type { ProviderId } from "~/lib/provider-config"

const TIER_SUFFIXES = ["-low", "-medium", "-high"] as const
const INTENSITY_SUFFIXES = ["-max", "-mini", "-nano"] as const
const SPEED_SUFFIX = "-fast"

const MODEL_ID_ALIASES: Record<string, string> = {
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.0-flash": "gemini-3-flash-preview",
  "gemini-pro-agent": "gemini-3.1-pro-preview",
}

function decodeOpaqueModelToken(token: string): string | undefined {
  const normalized = token.trim().toUpperCase()
  if (normalized.startsWith("MODEL_GPT_")) {
    return normalized
      .slice("MODEL_GPT_".length)
      .toLowerCase()
      .replaceAll("_", "-")
      .replace(/-(\d)-(\d)-/, "-$1.$2-")
      .replace(/-(\d)-(\d)$/, "-$1.$2")
  }
  if (normalized.startsWith("MODEL_GOOGLE_GEMINI_")) {
    const rest = normalized.slice("MODEL_GOOGLE_GEMINI_".length)
    const match = /^(\d)_(\d+)_(.+)$/.exec(rest)
    if (match) {
      const [, major, minor, tail] = match
      return `gemini-${major}.${minor}-${tail.toLowerCase().replaceAll("_", "-")}`
    }
  }
  return undefined
}

function swapDotDashVariants(modelId: string): Array<string> {
  const variants = new Set<string>([modelId])
  variants.add(modelId.replaceAll(/(\d)-(\d)/g, "$1.$2"))
  variants.add(modelId.replaceAll(/(\d)\.(\d)/g, "$1-$2"))
  return Array.from(variants)
}

function stripTierSuffix(modelId: string): string | undefined {
  for (const suffix of TIER_SUFFIXES) {
    if (modelId.endsWith(suffix) && modelId.length > suffix.length) {
      return modelId.slice(0, -suffix.length)
    }
  }
  return undefined
}

function stripIntensitySuffix(modelId: string): string | undefined {
  for (const suffix of INTENSITY_SUFFIXES) {
    if (modelId.endsWith(suffix) && modelId.length > suffix.length) {
      return modelId.slice(0, -suffix.length)
    }
  }
  return undefined
}

function stripSpeedSuffix(modelId: string): string | undefined {
  if (modelId.endsWith(SPEED_SUFFIX) && modelId.length > SPEED_SUFFIX.length) {
    return modelId.slice(0, -SPEED_SUFFIX.length)
  }
  return undefined
}

function applyAliases(modelId: string): Array<string> {
  const candidates = new Set<string>([modelId])
  const alias = MODEL_ID_ALIASES[modelId]
  if (alias) {
    candidates.add(alias)
  }
  return Array.from(candidates)
}

// Cap the number of stripped variants to avoid combinatorial blow-up on
// pathological model ids. Real model names have at most a handful of
// suffixes (e.g. "gpt-5-codex-low-max-fast" → 2^3 = 8 variants), so 32
// is a generous safety net.
const MAX_STRIPPED_VARIANTS = 32

function generateStrippedVariants(modelId: string): Array<string> {
  const seen = new Set<string>()
  const queue = [modelId]

  while (queue.length > 0 && seen.size < MAX_STRIPPED_VARIANTS) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)

    const withoutSpeed = stripSpeedSuffix(current)
    if (withoutSpeed) queue.push(withoutSpeed)

    const withoutIntensity = stripIntensitySuffix(current)
    if (withoutIntensity) queue.push(withoutIntensity)

    const withoutTier = stripTierSuffix(current)
    if (withoutTier) queue.push(withoutTier)
  }

  return Array.from(seen)
}

export function buildPricingLookupCandidates(
  nativeModelId: string,
  provider?: ProviderId,
): Array<string> {
  const candidates = new Set<string>()
  const add = (value?: string) => {
    if (!value?.trim()) return
    for (const variant of swapDotDashVariants(value.trim().toLowerCase())) {
      candidates.add(variant)
      for (const alias of applyAliases(variant)) {
        candidates.add(alias)
      }
    }
  }

  if (
    provider === "windsurf"
    && (/^swe-/i.test(nativeModelId) || /^model_private_/i.test(nativeModelId))
  ) {
    return []
  }

  for (const variant of generateStrippedVariants(nativeModelId)) {
    add(variant)
  }

  const decoded = decodeOpaqueModelToken(nativeModelId)
  if (decoded) {
    for (const variant of generateStrippedVariants(decoded)) {
      add(variant)
    }
  }

  for (const alias of applyAliases(nativeModelId)) {
    add(alias)
  }

  return Array.from(candidates)
}

export function inferWindsurfVendorBucket(
  nativeModelId: string,
): Array<string> {
  const id = nativeModelId.toLowerCase()
  if (
    id.startsWith("gpt-")
    || id.startsWith("o1")
    || id.startsWith("o3")
    || id.startsWith("o4")
    || id.includes("codex")
    || id.startsWith("model_gpt_")
  ) {
    return ["openai", "github-copilot"]
  }
  if (id.startsWith("claude-") || id.startsWith("model_claude_")) {
    return ["anthropic", "github-copilot"]
  }
  if (
    id.startsWith("gemini-")
    || id.startsWith("model_google_")
    || id.includes("gemini")
  ) {
    return ["google", "google-vertex"]
  }
  return []
}
