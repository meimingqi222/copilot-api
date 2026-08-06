const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 60_000
const MAX_FIRST_FRAME_TIMEOUT_MS = 10 * 60_000
const DEFAULT_FIRST_FRAME_RETRIES = 0
const MAX_FIRST_FRAME_RETRIES = 2
const DEFAULT_USER_JWT_CACHE_TTL_MS = 60_000
const MAX_USER_JWT_CACHE_TTL_MS = 10 * 60_000

function readBoundedInteger(
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

/** Time from HTTP 200 until the first forwardable model event. Zero disables. */
export function getWindsurfFirstFrameTimeoutMs(): number {
  return readBoundedInteger(
    "WINDSURF_FIRST_FRAME_TIMEOUT_MS",
    DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    MAX_FIRST_FRAME_TIMEOUT_MS,
  )
}

/** Same-account retries after a first-frame timeout. Account failover follows. */
export function getWindsurfFirstFrameRetries(): number {
  return readBoundedInteger(
    "WINDSURF_FIRST_FRAME_RETRIES",
    DEFAULT_FIRST_FRAME_RETRIES,
    MAX_FIRST_FRAME_RETRIES,
  )
}

/** In-memory GetUserJwt cache TTL. Zero disables. JWT expiry always wins. */
export function getWindsurfUserJwtCacheTtlMs(): number {
  return readBoundedInteger(
    "WINDSURF_USER_JWT_CACHE_TTL_MS",
    DEFAULT_USER_JWT_CACHE_TTL_MS,
    MAX_USER_JWT_CACHE_TTL_MS,
  )
}

export const WINDSURF_CONFIG_DEFAULTS = {
  firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  firstFrameRetries: DEFAULT_FIRST_FRAME_RETRIES,
  userJwtCacheTtlMs: DEFAULT_USER_JWT_CACHE_TTL_MS,
} as const
