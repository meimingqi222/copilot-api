import type {
  ModelEndpoint,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { AntigravityQuotaSummaryPayload } from "~/lib/quota/parsers"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  isCredentialAvailable,
  listAccountManagedConnections,
  persistProviderConnections,
} from "~/lib/provider-connections"
import {
  resolveClaudeQuotaWindows,
  resolveCodexQuotaWindows,
  resolveAntigravityQuotaWindows,
} from "~/lib/quota/cycles"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import {
  acquireRouteTargetSlot,
  routeTargetLoad,
} from "~/lib/route-target/load"
import { sanitizeDiagnosticSnippet } from "~/lib/security-sanitizer"
import { getSystemSettings } from "~/lib/system-config"
import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"
import { lowestCodexReasoningEffort } from "~/services/codex/client-models"
import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"

let running = false
const GRACE_MINUTES = 5
// Skips used to return silently, which made "warmed nothing" indistinguishable
// from "never ran". Report every reason once per slot: the ticker fires every
// 30s inside the five minute catch-up window, so repeating a reason would bury
// the single line that explains why nothing was sent.
let reportedSlot: string | undefined
const reportedSkips = new Map<string, string>()
type WarmupPool = keyof ReturnType<
  typeof getSystemSettings
>["accountWarmup"]["models"]

/** Protocols that a scheduled warmup can ever send for. Everything else is out of scope. */
const WARMABLE_PROTOCOLS = [
  "claude-native",
  "codex-native",
  "antigravity-native",
] as const

function isWarmableProtocol(connection: ProviderConnection): boolean {
  return (WARMABLE_PROTOCOLS as readonly string[]).includes(connection.protocol)
}

/**
 * Warm only when the five hour window is effectively untouched: more than
 * `WARMUP_MIN_REMAINING_PERCENT` of it is left. Requiring the window to have
 * expired meant an account with a trickle of traffic could never be warmed,
 * because any usage at all kept a window open.
 */
const WARMUP_MIN_REMAINING_PERCENT = 99

function fiveHourRemainingReason(window: {
  usedPercent?: number | null
  windowEndMs: number
}): string | undefined {
  const remaining = 100 - (window.usedPercent ?? 0)
  if (remaining > WARMUP_MIN_REMAINING_PERCENT) return undefined
  return `five hour window has ${Math.round(remaining * 10) / 10}% left (needs more than ${WARMUP_MIN_REMAINING_PERCENT}%), resets ${new Date(window.windowEndMs).toISOString()}`
}

function poolForModel(
  id: string,
): "antigravityGemini" | "antigravityClaude" | undefined {
  if (/^gemini-/i.test(id)) return "antigravityGemini"
  if (/^claude-/i.test(id)) return "antigravityClaude"
  return undefined
}

function lowCostFamilies(pool: WarmupPool) {
  // These are low-cost families, not a claim about exact subscription pricing.
  return (
    pool === "codex" ? [/-luna(?:-|$)/i, /-mini(?:-|$)/i]
    : pool === "antigravityGemini" ? [/^gemini-.*-flash(?:-|$)/i]
    : [/^claude-.*haiku(?:-|$)/i]
  )
}

function warmupCandidates(
  connection: ProviderConnection,
  pool: WarmupPool,
  endpoint: ModelEndpoint,
) {
  return (connection.models ?? []).filter(
    (model) =>
      model.enabled
      && model.endpoints.includes(endpoint)
      && (!pool.startsWith("antigravity")
        || poolForModel(model.upstreamId) === pool),
  )
}

export function getAccountWarmupModels() {
  const catalog: Record<
    WarmupPool,
    Array<{ id: string; name: string; recommended: boolean }>
  > = {
    claude: [],
    codex: [],
    antigravityGemini: [],
    antigravityClaude: [],
  }
  for (const pool of Object.keys(catalog) as WarmupPool[]) {
    const protocol =
      pool.startsWith("antigravity") ? "antigravity-native" : `${pool}-native`
    const endpoint =
      pool.startsWith("antigravity") ? "chat"
      : pool === "claude" ? "messages"
      : "responses"
    const models = new Map<
      string,
      { id: string; name: string; recommended: boolean }
    >()
    const families = lowCostFamilies(pool)
    for (const connection of listAccountManagedConnections()) {
      if (!connection.enabled || connection.protocol !== protocol) continue
      for (const model of warmupCandidates(connection, pool, endpoint)) {
        if (!models.has(model.upstreamId))
          models.set(model.upstreamId, {
            id: model.upstreamId,
            name: model.name || model.upstreamId,
            recommended: families.some((family) =>
              family.test(model.upstreamId),
            ),
          })
      }
    }
    const rank = (id: string) => {
      const index = families.findIndex((family) => family.test(id))
      return index < 0 ? families.length : index
    }
    catalog[pool] = [...models.values()].sort(
      (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
    )
  }
  return catalog
}

function selectModel(
  connection: ProviderConnection,
  pool: WarmupPool,
  endpoint: ModelEndpoint,
) {
  const configured = getSystemSettings().accountWarmup.models[pool]
  const candidates = warmupCandidates(connection, pool, endpoint)
  if (configured)
    return candidates.find((model) => model.upstreamId === configured)
  for (const family of lowCostFamilies(pool)) {
    const model = candidates.find((entry) => family.test(entry.upstreamId))
    if (model) return model
  }
  return undefined
}

function idleAntigravityReason(
  snapshot: QuotaSnapshot,
  pool: WarmupPool,
  now: number,
): string | undefined {
  const groups =
    (snapshot.details as AntigravityQuotaSummaryPayload).groups ?? []
  const matching = groups.filter((group) => {
    const label = group.displayName || group.display_name || ""
    const gemini = /gemini/i.test(label)
    const claude = /claude/i.test(label)
    return pool === "antigravityGemini" ? gemini && !claude : claude && !gemini
  })
  // Ambiguous groups and weekly-only/free plans are deliberately not warmed.
  if (matching.length !== 1)
    return matching.length === 0 ?
        `no quota group matched ${pool}`
      : `${matching.length} quota groups matched ${pool}`
  const windows = resolveAntigravityQuotaWindows({ groups: matching })
  const fiveHour = windows.find(
    (window) => window.windowEndMs - window.windowStartMs === 18_000_000,
  )
  const weekly = windows.find(
    (window) => window.windowEndMs - window.windowStartMs === 604_800_000,
  )
  if (!fiveHour) return "five hour window is missing"
  if (!weekly) return "weekly window is missing"
  if (fiveHour.usedPercent == null) return "five hour usage is unknown"
  const fiveHourLeft = fiveHourRemainingReason(fiveHour)
  if (fiveHourLeft) return fiveHourLeft
  if (weekly.usedPercent == null) return "weekly usage is unknown"
  if (weekly.usedPercent >= 100) return "weekly allowance is exhausted"
  if (weekly.windowEndMs <= now) return "weekly window has already ended"
  return undefined
}

function dueSlot(now: number): string | undefined {
  const config = getSystemSettings().accountWarmup
  if (!config.enabled) return undefined
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  )
  const minute = Number(fields.hour) * 60 + Number(fields.minute)
  const due = config.times
    .map((value) => {
      const [hour, minutes] = value.split(":").map(Number)
      const scheduled = hour * 60 + minutes
      return { value, scheduled, elapsed: (minute - scheduled + 1440) % 1440 }
    })
    .filter((entry) => entry.elapsed < GRACE_MINUTES)
    .sort((a, b) => a.elapsed - b.elapsed)[0]
  if (!due) return undefined
  const date = new Date(
    `${fields.year}-${fields.month}-${fields.day}T00:00:00Z`,
  )
  if (due.scheduled > minute) date.setUTCDate(date.getUTCDate() - 1)
  return `${config.timeZone}/${date.toISOString().slice(0, 10)}/${due.value}`
}

function ineligibleReason(connection: ProviderConnection): string | undefined {
  if (!getSystemSettings().accountWarmup.enabled)
    return "account warmup is disabled"
  if (getMutableProviderConnection(connection.id) !== connection)
    return "connection is no longer managed here"
  if (!connection.enabled) return "connection is disabled"
  if (!isWarmableProtocol(connection))
    return `protocol ${connection.protocol} is not warmed`
  const credential = connection.credentials[0]
  if (credential === undefined) return "connection has no credential"
  if (!isCredentialAvailable(credential))
    return `credential is resting (status ${credential.status ?? "unknown"})`
  const busy = ["chat", "messages", "responses", "gemini"].find(
    (endpoint) =>
      routeTargetLoad(`${connection.id}::${credential.id}::${endpoint}`) !== 0,
  )
  if (busy) return `connection is busy on ${busy}`
  return undefined
}

function idleWindowReason(
  connection: ProviderConnection,
  snapshot: QuotaSnapshot,
  now: number,
  pool: WarmupPool,
): string | undefined {
  if (!snapshot.details) return "quota read returned no window details"
  if (now - snapshot.fetchedAt > 60_000) return "quota read is stale"
  if (connection.protocol === "antigravity-native")
    return idleAntigravityReason(snapshot, pool, now)
  // A depleted weekly allowance must never turn a warmup into paid extra usage.
  if (snapshot.premiumInteractionsRemaining === undefined)
    return "weekly allowance is unknown"
  if (snapshot.premiumInteractionsRemaining <= 0)
    return "weekly allowance is exhausted"
  const windows =
    connection.protocol === "claude-native" ?
      resolveClaudeQuotaWindows(snapshot.details)
    : resolveCodexQuotaWindows(snapshot.details)
  const full = windows.find(
    (window) => (window.usedPercent ?? 0) >= 100 && window.windowEndMs > now,
  )
  if (full)
    return `${full.id} window is at ${Math.round(full.usedPercent ?? 0)}% until ${new Date(full.windowEndMs).toISOString()}`
  const fiveHour = windows.find((window) =>
    ["five_hour", "five-hour"].includes(window.id),
  )
  if (fiveHour) return fiveHourRemainingReason(fiveHour)
  // Claude explicitly returns null when the session window has not started.
  // Missing/malformed reset data must not be mistaken for an idle account.
  if (connection.protocol !== "claude-native")
    return "quota read has no five hour window"
  const raw = snapshot.details.five_hour
  if (raw === null) return undefined
  if (!raw || typeof raw !== "object")
    return "reset data is missing or malformed"
  const window = raw as { utilization?: number; resets_at?: unknown }
  return window.utilization === 0 && window.resets_at === null ?
      undefined
    : "session window has already started"
}

/** Test-only: the per-slot report dedupe is process state, so tests must clear it. */
export function resetWarmupReportingForTest(): void {
  reportedSlot = undefined
  reportedSkips.clear()
}

/**
 * Report a skipped warmup once per slot and remember why. `lastSkip` is durable
 * on purpose: the in-memory dedupe map dies with the process and the log rotates
 * away, so a no-op would otherwise be undiagnosable after a restart.
 */
async function reportSkip(
  connection: ProviderConnection,
  slot: string,
  pool: WarmupPool,
  reason: string,
): Promise<void> {
  const key = `${slot}::${connection.id}::${pool}`
  if (reportedSkips.get(key) === reason) return
  reportedSkips.set(key, reason)
  logger.info(
    `Account warmup skipped for "${connection.name}" (${pool}): ${reason}`,
  )
  const previous = connection.metadata?.accountWarmup as
    | Record<string, unknown>
    | undefined
  connection.metadata ??= {}
  connection.metadata.accountWarmup = {
    ...previous,
    lastSkip: { slot, pool, reason, at: Date.now() },
  }
  await persistProviderConnections()
}

async function warmConnection(
  connection: ProviderConnection,
  slot: string,
  pool: WarmupPool,
): Promise<void> {
  const ineligible = ineligibleReason(connection)
  if (ineligible) return reportSkip(connection, slot, pool, ineligible)
  const endpoint =
    connection.protocol === "antigravity-native" ? "chat"
    : connection.protocol === "claude-native" ? "messages"
    : "responses"
  const model = selectModel(connection, pool, endpoint)
  if (!model)
    return reportSkip(
      connection,
      slot,
      pool,
      `no enabled ${endpoint} model matched the ${pool} pool`,
    )
  const previous = connection.metadata?.accountWarmup as
    | {
        slot?: string
        pools?: Partial<Record<WarmupPool, { slot: string }>>
      }
    | undefined
  if (
    previous?.pools?.[pool]?.slot === slot
    || (!previous?.pools && previous?.slot === slot)
  )
    return
  const snapshot = await refreshManagedQuota(connection, { force: true })
  if (!snapshot)
    return reportSkip(connection, slot, pool, "quota read returned nothing")
  const busy = idleWindowReason(connection, snapshot, Date.now(), pool)
  if (busy) return reportSkip(connection, slot, pool, busy)
  const changed =
    ineligibleReason(connection)
    ?? (dueSlot(Date.now()) === slot ? undefined : "the catch-up window closed")
    ?? (selectModel(connection, pool, endpoint) === model ? undefined : (
      "the model selection changed"
    ))
  if (changed) return reportSkip(connection, slot, pool, changed)
  const attempt = {
    slot,
    attemptedAt: Date.now(),
    model: model.upstreamId,
    status: "pending",
    error: undefined as string | undefined,
  }
  connection.metadata ??= {}
  connection.metadata.accountWarmup = {
    ...attempt,
    pools: { ...previous?.pools, [pool]: attempt },
  }
  // Record before sending: a timeout or restart must not replay a billed request.
  await persistProviderConnections()
  const late =
    ineligibleReason(connection)
    ?? (dueSlot(Date.now()) === slot ? undefined : "the catch-up window closed")
    ?? (selectModel(connection, pool, endpoint) === model ? undefined : (
      "the model selection changed"
    ))
  if (late) {
    attempt.status = "skipped"
    attempt.error = `not sent: ${late}`
    logger.info(
      `Account warmup skipped for "${connection.name}" (${pool}): not sent, ${late}`,
    )
    Object.assign(connection.metadata.accountWarmup as object, attempt)
    await persistProviderConnections()
    return
  }
  const credential = connection.credentials[0]
  const release = acquireRouteTargetSlot(
    `${connection.id}::${credential.id}::${endpoint}`,
  )
  if (!release) return
  const signal = AbortSignal.timeout(30_000)
  try {
    const effort = lowestCodexReasoningEffort(connection.id, model.upstreamId)
    const response =
      endpoint === "chat" ?
        await createAntigravityChatCompletionsOnce(
          { connection, credential },
          {
            model: model.upstreamId,
            messages: [{ role: "user", content: "Reply only OK." }],
            max_tokens: 1,
            stream: false,
            ...(pool === "antigravityGemini" ?
              { reasoning_effort: "minimal" as const }
            : {}),
          },
          signal,
        )
      : endpoint === "messages" ?
        await createClaudeMessagesOnce(
          { connection, credential },
          {
            model: model.upstreamId,
            messages: [{ role: "user", content: "Reply only OK." }],
            max_tokens: 1,
            stream: false,
          },
          signal,
        )
      : await createCodexResponsesOnce(
          { connection, credential },
          {
            model: model.upstreamId,
            input: "Reply only OK.",
            tools: [],
            ...(effort ? { reasoning: { effort } } : {}),
            stream: false,
            store: false,
          },
          signal,
        )
    if ("error" in response && response.error)
      throw new Error("Upstream warmup returned an error")
    if (
      "status" in response
      && ["failed", "cancelled"].includes(String(response.status))
    )
      throw new Error("Upstream warmup did not complete")
    attempt.status = "succeeded"
    logger.info(
      `Account warmup succeeded for "${connection.name}" (${model.upstreamId})`,
    )
  } catch (error) {
    attempt.status = "failed"
    // The upstream body is the only place the real reason lives: a generic
    // "Failed to create Codex responses" is not diagnosable on its own.
    attempt.error = sanitizeDiagnosticSnippet(
      error instanceof HTTPError ?
        `HTTP ${error.response.status} ${error.responseBody || "(unreadable)"}`
      : error instanceof Error ? error.message
      : String(error),
      300,
    )
    logger.warn(
      `Account warmup failed for "${connection.name}": ${attempt.error}`,
    )
  } finally {
    release()
    Object.assign(connection.metadata.accountWarmup as object, attempt)
    await persistProviderConnections()
  }
}

/** Minimal real inference, opt-in only. Never edits or invents upstream reset times. */
export async function runAccountWarmups(now = Date.now()): Promise<void> {
  const slot = dueSlot(now)
  if (!slot || running) return
  running = true
  try {
    const managed = listAccountManagedConnections()
    const connections = managed.filter(isWarmableProtocol)
    if (reportedSlot !== slot) {
      reportedSlot = slot
      reportedSkips.clear()
      // One line per slot: proves the scheduler reached the configured time and
      // says how many warmable accounts were considered, even when nothing is
      // sent. Connections whose protocol is never warmed are left out so their
      // skips cannot bury the reasons that matter.
      logger.info(
        `Account warmup slot ${slot}: evaluating ${connections.length} warmable account connection(s)`
          + (managed.length > connections.length ?
            ` of ${managed.length} account connection(s)`
          : ""),
      )
      if (managed.length > connections.length)
        logger.debug(
          `Account warmup: ${managed.length - connections.length} account connection(s) use a protocol that is never warmed`,
        )
    }
    // Sequential sends avoid a burst of synthetic requests across all accounts.
    for (const connection of connections) {
      if (dueSlot(Date.now()) !== slot) break
      try {
        const pools: WarmupPool[] =
          connection.protocol === "antigravity-native" ?
            ["antigravityGemini", "antigravityClaude"]
          : connection.protocol === "claude-native" ? ["claude"]
          : ["codex"]
        for (const pool of pools) await warmConnection(connection, slot, pool)
      } catch (error) {
        logger.warn(
          `Account warmup skipped for "${connection.name}": ${sanitizeDiagnosticSnippet(error instanceof Error ? error.message : String(error), 300)}`,
        )
      }
    }
  } finally {
    running = false
  }
}
