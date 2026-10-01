// Rest-reason classification: why a candidate sits out and for how long.
//
// Phase 1 (this file) is the *taxonomy + skeleton*: a single canonical enum
// and a classifier that maps what we already know (credential status,
// cooldownUntil, upstream error kind, HTTP status) onto it. Phase 3 wires the
// durations into failover/availability so e.g. `quota` reads the real reset
// time instead of a flat 60s backoff — until then this file only names the
// reasons; it does not change behaviour.
//
// The reason set covers credit, quota, rate, verify, refused, canceled,
// foreign, proxy, shape and floor.

import type {
  ApiCredential,
  CredentialStatus,
} from "~/lib/provider-connections"

export type RestReason =
  | "credit" // out of credit/balance: until topped up
  | "quota" // quota/allowance used up: until its reset window
  | "rate" // rate-limited: until Retry-After / short backoff
  | "verify" // vendor demands account verification before reuse
  | "refused" // safety filter refused the request itself — don't rest
  | "canceled" // client went away — don't rest
  | "foreign" // sealed reasoning written by another account — don't rest
  | "proxy" // the proxy couldn't take the connection — don't rest
  | "shape" // the vendor couldn't read the request's shape — don't rest
  | "floor" // the reply was asked shorter than the vendor gives — don't rest
  | "network" // transport/5xx
  | "disabled" // administratively disabled
  | "unknown"

/**
 * What set how long a candidate sits out, so the Trace view can say *why*
 * the duration is what it is.
 */
export type RestBy =
  | "credit" // a flat half hour
  | "quota" // no word of when it resets
  | "retry-after" // the vendor's own header
  | "resets" // the time it said it comes back
  | "window" // the allowance window it filled renews
  | "cooldown" // the flat short cooldown
  | "backoff" // longer each time it fails again
  | "verify" // until someone verifies the account

export interface RestInfo {
  reason: RestReason
  untilMs?: number
  retryAfterMs?: number
  /** What set the duration (credit / retry-after / resets / window / …). */
  by?: RestBy
  /** Consecutive failures, when the duration is a backoff. */
  failures?: number
  /** The key this candidate rests by, so it can be lifted (unrest). */
  key?: string
  /** Where the vendor said to verify the account, for a `verify` rest. */
  link?: string
}

// ── Semantic classification + durations (Phase 3) ───────────────
//
// Read the vendor's words (not just
// the status) to tell "out of credit" from "out of quota" from "slow down",
// then rest for as long as that reason says. Until Phase 3 the durations
// came from one flat backoff; now quota reads the real reset window.

// Band durations.
const CREDIT_REST_MS = 30 * 60_000 // out of credit: until someone tops it up
const QUOTA_FLOOR_MS = 15 * 60_000 // out of quota, with no word of when
const QUOTA_CAP_MS = 8 * 24 * 3_600_000 // the most a quota rests, with words
const VERIFY_REST_MS = 30 * 60_000 // until someone verifies the account
/** The most a vendor's own "try again at" is trusted, for a rate limit. */
const LONGEST_WAIT_MS = 60 * 60_000

/** The account or key has no money left. */
const CREDIT_WORDS = new RegExp(
  String.raw`insufficient.?balance|insufficient.?credit|insufficient.?fund|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.{0,4}(不足|停)`,
  "i",
)
/** It has used up what its plan allows for now. */
const USED_UP_WORDS = new RegExp(
  String.raw`quota|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限`,
  "i",
)
/** A 429 that is a short rate limit — requests or tokens per minute. */
const RATE_WORDS = new RegExp(
  String.raw`rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁`,
  "i",
)
/** A 429 that says the plan's own allowance is used, rate words or not. */
const PLANNED_WORDS = new RegExp(
  String.raw`quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(day|week|month)|daily|weekly|monthly|额度|用量|套餐`,
  "i",
)
/** Claude Code's "usage limit reached|<unix when it resets>". */
const RESETS_WORDS = new RegExp(String.raw`limit reached\|(\d{10})\b`, "i")
/** The vendor wants the account verified before it is served again. */
const VERIFY_WORDS = new RegExp(
  String.raw`VALIDATION_REQUIRED|verification required|please verify|verify your (account|identity)|unverified|需要验证|验证你的?账户`,
  "i",
)
/** The vendor's safety filter refused the request itself — don't rest. */
const REFUSED_WORDS = new RegExp(
  String.raw`unapproved channel|illegal api invocation|blocked by security policy`,
  "i",
)
/**
 * The sealed reasoning in the request was written by another account (or
 * organization, or vendor) and can't be read here: OpenAI's
 * invalid_encrypted_content, xAI's "Could not
 * decrypt the provided encrypted_content". The request is sent again without
 * that reasoning — the account is fine, so nobody rests.
 */
const FOREIGN_WORDS = new RegExp(
  String.raw`invalid_encrypted_content|encrypted[ _]content.{0,80}could not be (verified|decrypted)|could not (decrypt|verify).{0,40}encrypted[ _]content`,
  "i",
)
/**
 * The proxy the gateway sends through couldn't take the connection (its own
 * setting, the *_PROXY variables, the system's): nothing reached the vendor,
 * so the account is as good as it was and nobody rests.
 */
const PROXY_WORDS = new RegExp(String.raw`proxyconnect |socks connect `, "i")

/** Reset instant (ms) from a body's resets_at / resets_in_seconds / words. */
function resetAtMsFromBody(
  body: string | undefined | null,
  now: number,
): number {
  if (!body) return 0
  const words = RESETS_WORDS.exec(body)
  if (words?.[1]) {
    const at = Number.parseInt(words[1], 10) * 1000
    if (at > now) return at
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error as Record<string, unknown> | undefined
    const at =
      parsed.resets_at ?? parsed.resetsAt ?? error?.resets_at ?? error?.resetsAt
    if (typeof at === "number" && at > 0) {
      const ms = at < 1e12 ? at * 1000 : at
      if (ms > now) return ms
    }
    const inSeconds =
      parsed.resets_in_seconds
      ?? parsed.resetsInSeconds
      ?? error?.resets_in_seconds
      ?? error?.resetsInSeconds
    if (typeof inSeconds === "number" && inSeconds > 0)
      return now + inSeconds * 1000
  } catch {
    // not JSON
  }
  return 0
}

/** Retry-After hint (ms) from headers, if any. */
function retryAfterMsFromHeaders(headers?: Headers | null): number | undefined {
  if (!headers) return undefined
  const raw = headers.get("retry-after")
  if (!raw) return undefined
  const seconds = Number.parseFloat(raw)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, LONGEST_WAIT_MS)
  }
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) {
    const diff = at - Date.now()
    if (diff > 0) return Math.min(diff, LONGEST_WAIT_MS)
  }
  return undefined
}

/**
 * Classify a failure into a rest reason by the vendor's words, status included.
 */
export function classifyRestReason(input: {
  status?: number
  body?: string | null
}): RestReason {
  const { status, body } = input
  const text = body ?? ""
  // Nothing reached the vendor: the proxy itself couldn't take the connection.
  if (status === 502 && PROXY_WORDS.test(text)) return "proxy"
  // Sealed reasoning another account wrote — resent without it, nobody rests.
  if (FOREIGN_WORDS.test(text)) return "foreign"
  if (REFUSED_WORDS.test(text)) return "refused"
  if ((status === 401 || status === 403) && VERIFY_WORDS.test(text)) {
    return "verify"
  }
  if (
    status === 402
    || (status !== 429 && CREDIT_WORDS.test(text))
    || text.includes("insufficient_quota")
  ) {
    return "credit"
  }
  if (status === 429 && RATE_WORDS.test(text) && !PLANNED_WORDS.test(text)) {
    return "rate"
  }
  if (
    USED_UP_WORDS.test(text)
    || (status === 429 && PLANNED_WORDS.test(text))
  ) {
    return "quota"
  }
  if (status === 429) return "rate"
  if (status === undefined || status >= 500) return "network"
  // A plain 4xx payload problem is not a rest reason of its own; the caller's
  // own client_error handling decides. (Only word-matched refusals above.)
  return "unknown"
}

interface RestDecisionInput {
  status?: number
  headers?: Headers | null
  body?: string | null
  /** Fallback duration when the reason does not imply one (backoff). */
  fallbackMs: number
  now?: number
}

export interface RestDecision {
  reason: RestReason
  /** How long the rest lasts, ms. Zero = no rest (rotate only). */
  restMs: number
  /** Absolute instant the rest lifts, ms epoch. Zero = no rest. */
  untilMs: number
  /** Real reset instant from the vendor's words, when it gave one. */
  resetAtMs: number
  /** What set the duration (credit / retry-after / resets / window / …). */
  by: RestBy
}

/** Decide duration for an already-known reason, from one shared table. */
export function restDecisionForReason(input: {
  reason: RestReason
  resetAtMs?: number
  retryAfterMs?: number
  fallbackMs?: number
  now?: number
}): RestDecision {
  const now = input.now ?? Date.now()
  const fallbackMs = input.fallbackMs ?? QUOTA_FLOOR_MS
  const resetAtMs =
    input.resetAtMs && input.resetAtMs > now ? input.resetAtMs : 0
  let restMs: number
  let by: RestBy
  switch (input.reason) {
    case "refused":
    case "canceled":
    case "foreign":
    case "proxy":
    case "shape":
    case "floor":
      // The request (or the transport) was the problem, not the account:
      // rotate to the next candidate without resting this one.
      restMs = 0
      by = "cooldown"
      break
    case "credit":
      restMs = CREDIT_REST_MS
      by = "credit"
      break
    case "verify":
      restMs = VERIFY_REST_MS
      by = "verify"
      break
    case "quota": {
      const window = resetAtMs > now ? resetAtMs - now : 0
      restMs = Math.min(Math.max(window, QUOTA_FLOOR_MS), QUOTA_CAP_MS)
      by = window > 0 ? "resets" : "quota"
      break
    }
    case "rate":
      if (input.retryAfterMs && input.retryAfterMs > 0) {
        restMs = input.retryAfterMs
        by = "retry-after"
      } else {
        restMs = fallbackMs
        by = "backoff"
      }
      break
    default:
      restMs = fallbackMs
      by = "backoff"
      break
  }
  return {
    reason: input.reason,
    restMs,
    untilMs: restMs > 0 ? now + restMs : 0,
    resetAtMs,
    by,
  }
}

/**
 * Decide why a candidate failed and for how long it should sit out, reading
 * the vendor's words over the status code. Quota reads the real window, credit
 * and verify are their own bands, a refusal or a client cancellation does not
 * rest at all.
 */
export function restDecisionFor(input: RestDecisionInput): RestDecision {
  const now = input.now ?? Date.now()
  return restDecisionForReason({
    reason: classifyRestReason({ status: input.status, body: input.body }),
    resetAtMs: resetAtMsFromBody(input.body, now),
    retryAfterMs: retryAfterMsFromHeaders(input.headers),
    fallbackMs: input.fallbackMs,
    now,
  })
}

/** Status → rest reason, for candidates that were never even selected. */
function restReasonForStatus(status: CredentialStatus): RestReason {
  switch (status) {
    case "quota_exhausted":
      return "quota"
    case "cooldown":
      return "rate"
    case "disabled":
      return "disabled"
    case "auth_error":
      return "verify"
    default:
      return "unknown"
  }
}

/**
 * Map an upstream error kind (from classifyUpstreamError) to a rest reason.
 * "rate_limited"/"server_error" are transient; "quota_exhausted" is a long
 * window; "auth_error" may mean verify.
 */
export function restReasonForErrorKind(kind: string): RestReason {
  switch (kind) {
    case "quota_exhausted":
      return "quota"
    case "rate_limited":
      return "rate"
    case "auth_error":
      return "verify"
    case "server_error":
    case "network_error":
      return "network"
    case "client_error":
      return "refused"
    default:
      return "unknown"
  }
}

/** Why a credential is resting right now (credential status + cooldown). */
export function restInfoForCredential(
  credential: ApiCredential | undefined,
): RestInfo | undefined {
  if (!credential) return undefined
  const status = credential.status
  if (status === "ready") return undefined
  const reason = restReasonForStatus(status)
  const untilMs =
    credential.cooldownUntil && credential.cooldownUntil > Date.now() ?
      credential.cooldownUntil
    : undefined
  const retryAfterMs =
    untilMs ? Math.max(0, Math.ceil(untilMs - Date.now())) : undefined
  const by: RestBy =
    reason === "quota" ? "quota"
    : reason === "verify" ? "verify"
    : "cooldown"
  return { reason, by, untilMs, retryAfterMs, key: credential.id }
}
