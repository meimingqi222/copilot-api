/**
 * Per-pool account warm-up targets.
 *
 * `warmup.ts` owns scheduling: slots, per-slot dedupe, persistence and the
 * skip report. Everything that differs between the warmable wires lives here
 * as data — which protocol and endpoint a pool warms, which model families
 * are cheap enough to send, what an idle quota window looks like, and how the
 * minimal request is sent. Adding a warmable provider is one entry here, not
 * another protocol/endpoint/pool branch in the scheduler.
 */

import type {
  ApiCredential,
  ModelEndpoint,
  ProviderConnection,
  ProviderProtocol,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { AntigravityQuotaSummaryPayload } from "~/lib/quota/parsers"
import type { getSystemSettings } from "~/lib/system-config"

import {
  resolveAntigravityQuotaWindows,
  resolveClaudeQuotaWindows,
  resolveCodexQuotaWindows,
} from "~/lib/quota/cycles"
import { createAntigravityChatCompletionsOnce } from "~/services/antigravity/create-chat-completions-once"
import { createClaudeMessagesOnce } from "~/services/claude/create-messages-once"
import { lowestCodexReasoningEffort } from "~/services/codex/client-models"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"

/**
 * A warm-up pool: one configured model slot per provider allowance. The set is
 * owned by the system-config schema, which is also what the admin editor and
 * the stored per-pool dedupe key use.
 */
export type WarmupPool = keyof ReturnType<
  typeof getSystemSettings
>["accountWarmup"]["models"]

/**
 * Warm only when the five hour window is effectively untouched: more than this
 * percentage of it is left. Requiring the window to have expired meant an
 * account with a trickle of traffic could never be warmed, because any usage
 * at all kept a window open.
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

interface IdleWindowInput {
  snapshot: QuotaSnapshot
  details: Record<string, unknown>
  now: number
}

interface WarmupSendInput {
  connection: ProviderConnection
  credential: ApiCredential
  model: string
  signal: AbortSignal
}

export interface WarmupTarget {
  pool: WarmupPool
  /** Connection protocol whose allowance this pool spends. */
  protocol: ProviderProtocol
  /** Wire endpoint the pool's models must support (and the slot is keyed by). */
  endpoint: ModelEndpoint
  /** Low-cost families worth a synthetic request, best first. */
  lowCostFamilies: ReadonlyArray<RegExp>
  /** Restricts candidates to this pool; undefined accepts every model. */
  acceptsModel?: (upstreamId: string) => boolean
  idleReason(input: IdleWindowInput): string | undefined
  send(input: WarmupSendInput): Promise<unknown>
}

function antigravityIdleReason(
  input: IdleWindowInput,
  pool: "antigravityGemini" | "antigravityClaude",
): string | undefined {
  const groups = (input.details as AntigravityQuotaSummaryPayload).groups ?? []
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
  if (weekly.windowEndMs <= input.now) return "weekly window has already ended"
  return undefined
}

type QuotaWindows = ReturnType<typeof resolveClaudeQuotaWindows>

function oauthIdleReason(
  resolveWindows: (details: Record<string, unknown>) => QuotaWindows,
  claudeSessionWindow: boolean,
): (input: IdleWindowInput) => string | undefined {
  return (input) => {
    // A depleted weekly allowance must never turn a warmup into paid extra usage.
    if (input.snapshot.premiumInteractionsRemaining === undefined)
      return "weekly allowance is unknown"
    if (input.snapshot.premiumInteractionsRemaining <= 0)
      return "weekly allowance is exhausted"
    const windows = resolveWindows(input.details)
    const full = windows.find(
      (window) =>
        (window.usedPercent ?? 0) >= 100 && window.windowEndMs > input.now,
    )
    if (full)
      return `${full.id} window is at ${Math.round(full.usedPercent ?? 0)}% until ${new Date(full.windowEndMs).toISOString()}`
    const fiveHour = windows.find((window) =>
      ["five_hour", "five-hour"].includes(window.id),
    )
    if (fiveHour) return fiveHourRemainingReason(fiveHour)
    // Claude explicitly returns null when the session window has not started.
    // Missing/malformed reset data must not be mistaken for an idle account.
    if (!claudeSessionWindow) return "quota read has no five hour window"
    const raw = input.details.five_hour
    if (raw === null) return undefined
    if (!raw || typeof raw !== "object")
      return "reset data is missing or malformed"
    const window = raw as { utilization?: number; resets_at?: unknown }
    return window.utilization === 0 && window.resets_at === null ?
        undefined
      : "session window has already started"
  }
}

function antigravitySender(reasoningEffort: boolean) {
  return async ({ connection, credential, model, signal }: WarmupSendInput) =>
    createAntigravityChatCompletionsOnce(
      { connection, credential },
      {
        model,
        messages: [{ role: "user", content: "Reply only OK." }],
        max_tokens: 1,
        stream: false,
        ...(reasoningEffort ?
          // Pro models reject minimal; low is supported by Pro and Flash.
          { reasoning_effort: "low" as const }
        : {}),
      },
      signal,
    )
}

async function sendClaudeMessages({
  connection,
  credential,
  model,
  signal,
}: WarmupSendInput) {
  return createClaudeMessagesOnce(
    { connection, credential },
    {
      model,
      messages: [{ role: "user", content: "Reply only OK." }],
      max_tokens: 1,
      stream: false,
    },
    signal,
  )
}

async function sendCodexResponses({
  connection,
  credential,
  model,
  signal,
}: WarmupSendInput) {
  const effort = lowestCodexReasoningEffort(connection.id, model)
  return createCodexResponsesOnce(
    { connection, credential },
    {
      model,
      // The upstream rejects a bare string: input must be a list of
      // message items (400 "Input must be a list").
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Reply only OK." }],
        },
      ],
      tools: [],
      ...(effort ? { reasoning: { effort } } : {}),
      stream: false,
      store: false,
    },
    signal,
  )
}

const TARGETS: Record<WarmupPool, WarmupTarget> = {
  claude: {
    pool: "claude",
    protocol: "claude-native",
    endpoint: "messages",
    lowCostFamilies: [/^claude-.*haiku(?:-|$)/i],
    idleReason: oauthIdleReason(resolveClaudeQuotaWindows, true),
    send: sendClaudeMessages,
  },
  codex: {
    pool: "codex",
    protocol: "codex-native",
    endpoint: "responses",
    // These are low-cost families, not a claim about exact subscription pricing.
    lowCostFamilies: [/-luna(?:-|$)/i, /-mini(?:-|$)/i],
    idleReason: oauthIdleReason(resolveCodexQuotaWindows, false),
    send: sendCodexResponses,
  },
  antigravityGemini: {
    pool: "antigravityGemini",
    protocol: "antigravity-native",
    endpoint: "chat",
    lowCostFamilies: [/^gemini-.*-flash(?:-|$)/i],
    acceptsModel: (upstreamId) => /^gemini-/i.test(upstreamId),
    idleReason: (input) => antigravityIdleReason(input, "antigravityGemini"),
    send: antigravitySender(true),
  },
  antigravityClaude: {
    pool: "antigravityClaude",
    protocol: "antigravity-native",
    endpoint: "chat",
    lowCostFamilies: [/^claude-.*haiku(?:-|$)/i],
    acceptsModel: (upstreamId) => /^claude-/i.test(upstreamId),
    idleReason: (input) => antigravityIdleReason(input, "antigravityClaude"),
    send: antigravitySender(false),
  },
}

/** Declared order is the pool order the catalog and the scheduler walk. */
export const WARMUP_TARGETS: ReadonlyArray<WarmupTarget> =
  Object.values(TARGETS)

const TARGETS_BY_PROTOCOL = new Map<ProviderProtocol, Array<WarmupTarget>>()
for (const target of WARMUP_TARGETS) {
  const list = TARGETS_BY_PROTOCOL.get(target.protocol) ?? []
  list.push(target)
  TARGETS_BY_PROTOCOL.set(target.protocol, list)
}

/** Whether a scheduled warmup can ever send for this protocol. */
export function isWarmableProtocol(protocol: ProviderProtocol): boolean {
  return TARGETS_BY_PROTOCOL.has(protocol)
}

/** Every pool a connection of this protocol warms, in declared order. */
export function warmupTargetsForProtocol(
  protocol: ProviderProtocol,
): ReadonlyArray<WarmupTarget> {
  return TARGETS_BY_PROTOCOL.get(protocol) ?? []
}
