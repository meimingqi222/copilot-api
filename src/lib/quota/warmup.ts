import type { ProviderConnection } from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { WarmupPool, WarmupTarget } from "~/lib/quota/warmup-targets"

import { HTTPError } from "~/lib/error"
import { createLogger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  isCredentialAvailable,
  listAccountManagedConnections,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import {
  isWarmableProtocol,
  WARMUP_TARGETS,
  warmupTargetsForProtocol,
} from "~/lib/quota/warmup-targets"
import {
  acquireRouteTargetSlot,
  routeTargetLoad,
} from "~/lib/route-target/load"
import { sanitizeDiagnosticSnippet } from "~/lib/security-sanitizer"
import { getSystemSettings } from "~/lib/system-config"
import { IR_WIRES } from "~/services/ir/types"

const logger = createLogger("quota")

let running = false
const GRACE_MINUTES = 5
// Skips used to return silently, which made "warmed nothing" indistinguishable
// from "never ran". Report every reason once per slot: the ticker fires every
// 30s inside the five minute catch-up window, so repeating a reason would bury
// the single line that explains why nothing was sent.
let reportedSlot: string | undefined
const reportedSkips = new Map<string, string>()

function warmupCandidates(
  connection: ProviderConnection,
  target: WarmupTarget,
) {
  return (connection.models ?? []).filter(
    (model) =>
      model.enabled
      && model.endpoints.includes(target.endpoint)
      && (target.acceptsModel?.(model.upstreamId) ?? true),
  )
}

export function getAccountWarmupModels() {
  const catalog = {} as Record<
    WarmupPool,
    Array<{ id: string; name: string; recommended: boolean }>
  >
  for (const target of WARMUP_TARGETS) {
    const models = new Map<
      string,
      { id: string; name: string; recommended: boolean }
    >()
    const families = target.lowCostFamilies
    for (const connection of listAccountManagedConnections()) {
      if (!connection.enabled || connection.protocol !== target.protocol)
        continue
      for (const model of warmupCandidates(connection, target)) {
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
    catalog[target.pool] = [...models.values()].sort(
      (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
    )
  }
  return catalog
}

function selectModel(connection: ProviderConnection, target: WarmupTarget) {
  const configured = getSystemSettings().accountWarmup.models[target.pool]
  const candidates = warmupCandidates(connection, target)
  if (configured)
    return candidates.find((model) => model.upstreamId === configured)
  for (const family of target.lowCostFamilies) {
    const model = candidates.find((entry) => family.test(entry.upstreamId))
    if (model) return model
  }
  return undefined
}

function idleWindowReason(
  snapshot: QuotaSnapshot,
  now: number,
  target: WarmupTarget,
): string | undefined {
  const details = snapshot.details
  if (!details) return "quota read returned no window details"
  if (now - snapshot.fetchedAt > 60_000) return "quota read is stale"
  return target.idleReason({ snapshot, details, now })
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
  if (!isWarmableProtocol(connection.protocol))
    return `protocol ${connection.protocol} is not warmed`
  const credential = connection.credentials[0]
  if (credential === undefined) return "connection has no credential"
  if (!isCredentialAvailable(credential))
    return `credential is resting (status ${credential.status ?? "unknown"})`
  const busy = IR_WIRES.find(
    (endpoint) =>
      routeTargetLoad(`${connection.id}::${credential.id}::${endpoint}`) !== 0,
  )
  if (busy) return `connection is busy on ${busy}`
  return undefined
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

/**
 * Why a warm-up reply means the request did not go through, if it does. The
 * three senders return different reply shapes, but only these two markers say
 * the upstream refused or aborted the turn.
 */
function warmupFailure(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined
  if ("error" in response && response.error)
    return "Upstream warmup returned an error"
  if (
    "status" in response
    && ["failed", "cancelled"].includes(String(response.status))
  )
    return "Upstream warmup did not complete"
  return undefined
}

async function warmConnection(
  connection: ProviderConnection,
  slot: string,
  target: WarmupTarget,
): Promise<void> {
  const { pool } = target
  const ineligible = ineligibleReason(connection)
  if (ineligible) return reportSkip(connection, slot, pool, ineligible)
  const model = selectModel(connection, target)
  if (!model)
    return reportSkip(
      connection,
      slot,
      pool,
      `no enabled ${target.endpoint} model matched the ${pool} pool`,
    )
  // Discovery and models-stale listeners can rebuild equivalent model objects.
  // Capture the wire identity so replacements pass and in-place changes do not.
  const upstreamId = model.upstreamId
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
  const busy = idleWindowReason(snapshot, Date.now(), target)
  if (busy) return reportSkip(connection, slot, pool, busy)
  const changed =
    ineligibleReason(connection)
    ?? (dueSlot(Date.now()) === slot ? undefined : "the catch-up window closed")
    ?? (selectModel(connection, target)?.upstreamId === upstreamId ?
      undefined
    : "the model selection changed")
  if (changed) return reportSkip(connection, slot, pool, changed)
  const attempt = {
    slot,
    attemptedAt: Date.now(),
    model: upstreamId,
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
    ?? (selectModel(connection, target)?.upstreamId === upstreamId ?
      undefined
    : "the model selection changed")
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
    `${connection.id}::${credential.id}::${target.endpoint}`,
  )
  if (!release) return
  const signal = AbortSignal.timeout(30_000)
  try {
    const failure = warmupFailure(
      await target.send({ connection, credential, model: upstreamId, signal }),
    )
    if (failure) throw new Error(failure)
    attempt.status = "succeeded"
    logger.info(
      `Account warmup succeeded for "${connection.name}" (${upstreamId})`,
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
    const connections = managed.filter((connection) =>
      isWarmableProtocol(connection.protocol),
    )
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
        for (const target of warmupTargetsForProtocol(connection.protocol))
          await warmConnection(connection, slot, target)
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
