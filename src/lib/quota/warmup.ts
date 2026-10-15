import type {
  ModelEndpoint,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { AntigravityQuotaSummaryPayload } from "~/lib/quota/parsers"

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
type WarmupPool = keyof ReturnType<
  typeof getSystemSettings
>["accountWarmup"]["models"]

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

function idleAntigravityPool(
  snapshot: QuotaSnapshot,
  pool: WarmupPool,
  now: number,
): boolean {
  const groups =
    (snapshot.details as AntigravityQuotaSummaryPayload).groups ?? []
  const matching = groups.filter((group) => {
    const label = group.displayName || group.display_name || ""
    const gemini = /gemini/i.test(label)
    const claude = /claude/i.test(label)
    return pool === "antigravityGemini" ? gemini && !claude : claude && !gemini
  })
  // Ambiguous groups and weekly-only/free plans are deliberately not warmed.
  if (matching.length !== 1) return false
  const windows = resolveAntigravityQuotaWindows({ groups: matching })
  const fiveHour = windows.find(
    (window) => window.windowEndMs - window.windowStartMs === 18_000_000,
  )
  const weekly = windows.find(
    (window) => window.windowEndMs - window.windowStartMs === 604_800_000,
  )
  return (
    !!fiveHour
    && !!weekly
    && fiveHour.windowEndMs <= now
    && fiveHour.usedPercent != null
    && fiveHour.usedPercent < 100
    && weekly.usedPercent != null
    && weekly.usedPercent < 100
    && weekly.windowEndMs > now
  )
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

function eligible(connection: ProviderConnection): boolean {
  const credential = connection.credentials[0]
  return (
    getSystemSettings().accountWarmup.enabled
    && getMutableProviderConnection(connection.id) === connection
    && connection.enabled
    && ["claude-native", "codex-native", "antigravity-native"].includes(
      connection.protocol,
    )
    && credential !== undefined
    && isCredentialAvailable(credential)
    && ["chat", "messages", "responses", "gemini"].every(
      (endpoint) =>
        routeTargetLoad(`${connection.id}::${credential.id}::${endpoint}`)
        === 0,
    )
  )
}

function idleWindow(
  connection: ProviderConnection,
  snapshot: QuotaSnapshot,
  now: number,
  pool: WarmupPool,
): boolean {
  if (!snapshot.details || now - snapshot.fetchedAt > 60_000) return false
  if (connection.protocol === "antigravity-native")
    return idleAntigravityPool(snapshot, pool, now)
  // A depleted weekly allowance must never turn a warmup into paid extra usage.
  if (
    snapshot.premiumInteractionsRemaining === undefined
    || snapshot.premiumInteractionsRemaining <= 0
  )
    return false
  const windows =
    connection.protocol === "claude-native" ?
      resolveClaudeQuotaWindows(snapshot.details)
    : resolveCodexQuotaWindows(snapshot.details)
  if (
    windows.some(
      (window) => (window.usedPercent ?? 0) >= 100 && window.windowEndMs > now,
    )
  )
    return false
  const fiveHour = windows.find((window) =>
    ["five_hour", "five-hour"].includes(window.id),
  )
  if (fiveHour) return fiveHour.windowEndMs <= now
  // Claude explicitly returns null when the session window has not started.
  // Missing/malformed reset data must not be mistaken for an idle account.
  if (connection.protocol !== "claude-native") return false
  const raw = snapshot.details.five_hour
  if (raw === null) return true
  if (!raw || typeof raw !== "object") return false
  const window = raw as { utilization?: number; resets_at?: unknown }
  return window.utilization === 0 && window.resets_at === null
}

async function warmConnection(
  connection: ProviderConnection,
  slot: string,
  pool: WarmupPool,
): Promise<void> {
  if (!eligible(connection)) return
  const endpoint =
    connection.protocol === "antigravity-native" ? "chat"
    : connection.protocol === "claude-native" ? "messages"
    : "responses"
  const model = selectModel(connection, pool, endpoint)
  if (!model) return
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
  if (
    !snapshot
    || !idleWindow(connection, snapshot, Date.now(), pool)
    || !eligible(connection)
    || selectModel(connection, pool, endpoint) !== model
  )
    return
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
  if (
    !eligible(connection)
    || dueSlot(Date.now()) !== slot
    || selectModel(connection, pool, endpoint) !== model
  )
    return
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
    attempt.error = sanitizeDiagnosticSnippet(
      error instanceof Error ? error.message : String(error),
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
    // Sequential sends avoid a burst of synthetic requests across all accounts.
    for (const connection of listAccountManagedConnections()) {
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
