// Guard policy config — single source of truth for protection thresholds.
// Covers protected-route-guard (per-principal temp blocks) and client-guard
// (IP/UA suspicious scoring). Persisted inside guard.json `config` field.

export interface GuardConfig {
  // ── protected-route-guard ──
  requestLimit: number
  trustedRequestLimit: number
  upstream429DenseThreshold: number
  upstream429TotalThreshold: number
  burstBlockThreshold: number
  failureRateBlockThreshold: number
  minSamplesFailureRate: number
  repeatedContentThreshold: number
  repeatedContentWindowMs: number
  tempBlockMs: number
  // ── token bucket (L0 rate limiting, per principal × route class) ──
  bucketCapacity: number
  bucketTokenRefillPerSec: number
  bucketTokenCapacity: number
  // ── behavior scoring v2 (weighted, leaky) ──
  scoreReviewThreshold: number
  scoreSoftThreshold: number
  scoreSevereThreshold: number
  shortBlockMs: number
  longBlockMs: number
  escalationWindowMs: number
  repeatSuppressMs: number
  modelEnumThreshold: number
  authProbeThreshold: number
  shadowMode: boolean
  // ── client-guard scoring ──
  errorRateThreshold: number
  highFrequencyThreshold: number
  authFailureThreshold: number
  pathScanningThreshold: number
  burstRequestThreshold: number
  autoBlockScoreThreshold: number
  // ── UA patterns (stored as case-insensitive substrings / regex sources) ──
  trustedClientPatterns: Array<string>
  automationPatterns: Array<string>
  probePatterns: Array<string>
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  requestLimit: 240,
  trustedRequestLimit: 480,
  upstream429DenseThreshold: 5,
  upstream429TotalThreshold: 15,
  burstBlockThreshold: 100,
  failureRateBlockThreshold: 0.7,
  minSamplesFailureRate: 20,
  repeatedContentThreshold: 8,
  repeatedContentWindowMs: 60 * 60 * 1000,
  tempBlockMs: 30 * 60 * 1000,
  bucketCapacity: 40,
  bucketTokenRefillPerSec: 0.5,
  bucketTokenCapacity: 10,
  scoreReviewThreshold: 30,
  scoreSoftThreshold: 50,
  scoreSevereThreshold: 75,
  shortBlockMs: 5 * 60 * 1000,
  longBlockMs: 2 * 60 * 60 * 1000,
  escalationWindowMs: 60 * 60 * 1000,
  repeatSuppressMs: 60 * 60 * 1000,
  modelEnumThreshold: 8,
  authProbeThreshold: 8,
  shadowMode: false,
  errorRateThreshold: 0.3,
  highFrequencyThreshold: 100,
  authFailureThreshold: 8,
  pathScanningThreshold: 8,
  burstRequestThreshold: 20,
  autoBlockScoreThreshold: 80,
  trustedClientPatterns: [
    "charm-crush",
    "claude-code",
    "codex",
    "cursor",
    "windsurf",
    "zed-editor",
    "opencode",
    String.raw`amp[\s/-]`,
    "droid",
  ],
  automationPatterns: [
    "python-requests",
    "python-httpx",
    "curl",
    "wget",
    String.raw`http\.js`,
    "axios",
    "node-fetch",
    "got/",
    "scrapy",
    "selenium",
    "puppeteer",
    "playwright",
    "headless",
    "bot",
    "crawler",
    "spider",
  ],
  probePatterns: [
    String.raw`Please repeat:\s*\w{6,}`,
    String.raw`repeat your system prompt`,
    String.raw`reveal your (system )?instructions`,
    String.raw`ignore all previous instructions`,
    String.raw`you are now in developer mode`,
  ],
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function readPatternsEnv(name: string): Array<string> | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

function applyEnvOverrides(base: GuardConfig): GuardConfig {
  return {
    ...base,
    requestLimit: readNumberEnv("GUARD_REQUEST_LIMIT") ?? base.requestLimit,
    trustedRequestLimit:
      readNumberEnv("GUARD_TRUSTED_REQUEST_LIMIT") ?? base.trustedRequestLimit,
    upstream429DenseThreshold:
      readNumberEnv("GUARD_UPSTREAM_429_DENSE")
      ?? base.upstream429DenseThreshold,
    upstream429TotalThreshold:
      readNumberEnv("GUARD_UPSTREAM_429_TOTAL")
      ?? base.upstream429TotalThreshold,
    burstBlockThreshold:
      readNumberEnv("GUARD_BURST_THRESHOLD") ?? base.burstBlockThreshold,
    failureRateBlockThreshold: (() => {
      const raw = process.env.GUARD_FAILURE_RATE?.trim()
      if (!raw) return base.failureRateBlockThreshold
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 && n <= 1 ?
          n
        : base.failureRateBlockThreshold
    })(),
    repeatedContentThreshold:
      readNumberEnv("GUARD_REPEATED_THRESHOLD")
      ?? base.repeatedContentThreshold,
    tempBlockMs: readNumberEnv("GUARD_TEMP_BLOCK_MS") ?? base.tempBlockMs,
    shortBlockMs: readNumberEnv("GUARD_SHORT_BLOCK_MS") ?? base.shortBlockMs,
    longBlockMs: readNumberEnv("GUARD_LONG_BLOCK_MS") ?? base.longBlockMs,
    errorRateThreshold: (() => {
      const raw = process.env.GUARD_ERROR_RATE?.trim()
      if (!raw) return base.errorRateThreshold
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : base.errorRateThreshold
    })(),
    authFailureThreshold:
      readNumberEnv("GUARD_AUTH_FAILURE_THRESHOLD")
      ?? base.authFailureThreshold,
    autoBlockScoreThreshold:
      readNumberEnv("GUARD_AUTO_BLOCK_SCORE") ?? base.autoBlockScoreThreshold,
    trustedClientPatterns:
      readPatternsEnv("GUARD_TRUSTED_CLIENTS") ?? base.trustedClientPatterns,
    automationPatterns:
      readPatternsEnv("GUARD_AUTOMATION_PATTERNS") ?? base.automationPatterns,
  }
}

let current: GuardConfig = applyEnvOverrides({ ...DEFAULT_GUARD_CONFIG })

export function getGuardConfig(): GuardConfig {
  return {
    ...current,
    trustedClientPatterns: [...current.trustedClientPatterns],
    automationPatterns: [...current.automationPatterns],
    probePatterns: [...current.probePatterns],
  }
}

export function setGuardConfig(patch: Partial<GuardConfig>): GuardConfig {
  current = { ...current, ...patch }
  return getGuardConfig()
}

export function loadGuardConfigFromPersistence(
  data: Partial<GuardConfig> | null | undefined,
): GuardConfig {
  const envBase = applyEnvOverrides({ ...DEFAULT_GUARD_CONFIG })
  if (!data || typeof data !== "object") {
    current = envBase
    return getGuardConfig()
  }
  const sanitized = sanitizeGuardConfigPatch(data)
  current = { ...envBase, ...sanitized }
  // Migrate pre-v2 defaults that were too aggressive (persisted by earlier
  // versions on every saveGuard): adopt the new safer defaults unless the
  // admin explicitly changed them to a different value.
  if (data.repeatedContentThreshold === 3) {
    current.repeatedContentThreshold =
      DEFAULT_GUARD_CONFIG.repeatedContentThreshold
  }
  if (data.minSamplesFailureRate === 10) {
    current.minSamplesFailureRate = DEFAULT_GUARD_CONFIG.minSamplesFailureRate
  }
  if (
    Array.isArray(data.probePatterns)
    && data.probePatterns.length === 1
    && data.probePatterns[0] === String.raw`Please repeat:\s*\w{6,}`
  ) {
    current.probePatterns = [...DEFAULT_GUARD_CONFIG.probePatterns]
  }
  return getGuardConfig()
}

export function resetGuardConfigForTest(): void {
  current = { ...DEFAULT_GUARD_CONFIG }
}

const INT_KEYS = [
  "requestLimit",
  "trustedRequestLimit",
  "upstream429DenseThreshold",
  "upstream429TotalThreshold",
  "burstBlockThreshold",
  "minSamplesFailureRate",
  "repeatedContentThreshold",
  "repeatedContentWindowMs",
  "tempBlockMs",
  "bucketCapacity",
  "bucketTokenCapacity",
  "scoreReviewThreshold",
  "scoreSoftThreshold",
  "scoreSevereThreshold",
  "shortBlockMs",
  "longBlockMs",
  "escalationWindowMs",
  "repeatSuppressMs",
  "modelEnumThreshold",
  "authProbeThreshold",
  "highFrequencyThreshold",
  "authFailureThreshold",
  "pathScanningThreshold",
  "burstRequestThreshold",
  "autoBlockScoreThreshold",
] as const

const RATE_KEYS = ["failureRateBlockThreshold", "errorRateThreshold"] as const

const FLOAT_KEYS = ["bucketTokenRefillPerSec"] as const

const BOOL_KEYS = ["shadowMode"] as const

const PATTERN_KEYS = [
  "trustedClientPatterns",
  "automationPatterns",
  "probePatterns",
] as const

export function sanitizeGuardConfigPatch(
  patch: Record<string, unknown>,
): Partial<GuardConfig> {
  const out: Partial<GuardConfig> = {}
  for (const key of INT_KEYS) {
    const v = patch[key]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.floor(v)
    }
  }
  for (const key of RATE_KEYS) {
    const v = patch[key]
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) {
      ;(out as Record<string, number>)[key] = v
    }
  }
  for (const key of FLOAT_KEYS) {
    const v = patch[key]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      ;(out as Record<string, number>)[key] = v
    }
  }
  for (const key of BOOL_KEYS) {
    const v = patch[key]
    if (typeof v === "boolean") {
      ;(out as Record<string, boolean>)[key] = v
    }
  }
  for (const key of PATTERN_KEYS) {
    const v = patch[key]
    if (Array.isArray(v)) {
      const cleaned = v
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 100)
      // Validate each compiles as regex; drop invalid ones.
      const valid = cleaned.filter((s) => {
        try {
          new RegExp(s, "i")
          return true
        } catch {
          return false
        }
      })
      if (cleaned.length > 0 && valid.length === 0) {
        continue
      }
      ;(out as Record<string, Array<string>>)[key] = valid
    }
  }
  return out
}

export function validateGuardConfigPatch(
  patch: Record<string, unknown>,
): { ok: true; patch: Partial<GuardConfig> } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "Invalid JSON payload." }
  }
  const known = new Set<string>([
    ...INT_KEYS,
    ...RATE_KEYS,
    ...FLOAT_KEYS,
    ...BOOL_KEYS,
    ...PATTERN_KEYS,
  ])
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) {
      return { ok: false, error: `Unknown config key: ${key}` }
    }
  }
  // Field-level validation with clear messages (before sanitization).
  for (const key of INT_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return { ok: false, error: `${key} must be a positive number.` }
      }
      if (key === "tempBlockMs" && v < 60_000) {
        return { ok: false, error: "tempBlockMs must be >= 60000." }
      }
      if ((key === "shortBlockMs" || key === "longBlockMs") && v < 60_000) {
        return { ok: false, error: `${key} must be >= 60000.` }
      }
    }
  }
  for (const key of RATE_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
        return { ok: false, error: `${key} must be within (0, 1].` }
      }
    }
  }
  for (const key of FLOAT_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return { ok: false, error: `${key} must be a positive number.` }
      }
    }
  }
  for (const key of BOOL_KEYS) {
    if (key in patch && typeof patch[key] !== "boolean") {
      return { ok: false, error: `${key} must be a boolean.` }
    }
  }
  for (const key of PATTERN_KEYS) {
    if (key in patch) {
      const v = patch[key]
      if (!Array.isArray(v)) {
        return { ok: false, error: `${key} must be an array of strings.` }
      }
      for (const s of v) {
        if (typeof s !== "string" || !s.trim()) {
          return { ok: false, error: `${key} must contain non-empty strings.` }
        }
        try {
          new RegExp(s, "i")
        } catch {
          return { ok: false, error: `Invalid regex in ${key}: ${s}` }
        }
      }
    }
  }
  if (
    "requestLimit" in patch
    && "trustedRequestLimit" in patch
    && typeof patch.requestLimit === "number"
    && typeof patch.trustedRequestLimit === "number"
    && patch.trustedRequestLimit < patch.requestLimit
  ) {
    return {
      ok: false,
      error: "trustedRequestLimit must be >= requestLimit.",
    }
  }
  return { ok: true, patch: sanitizeGuardConfigPatch(patch) }
}

export function compilePatterns(sources: Array<string>): Array<RegExp> {
  const out: Array<RegExp> = []
  for (const s of sources) {
    try {
      out.push(new RegExp(s, "i"))
    } catch {
      // Skip invalid — validation blocks these at write time.
    }
  }
  return out
}
