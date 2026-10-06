import { isLlmRequest } from "~/lib/llm-request"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogEndpoint =
  | "chat"
  | "messages"
  | "responses"
  | "gemini"
  | "embeddings"
  | "images"
  | "videos"
  | "other"

export type ApiKind = "chat" | "messages" | "responses" | "embeddings" | "other"
export type TraceStage =
  | "gate"
  | "admission"
  | "upstream"
  | "dispatch"
  | "client"
  | "abort"

export interface UpstreamAttempt {
  serviceTierUpstream?: string
  serviceTierResponse?: string
  n: number
  connectionId: string
  connectionName?: string
  credentialId: string
  credentialLabel?: string
  endpoint: string
  protocol: string
  provider?: string
  upstreamBaseUrl?: string
  status?: number
  latencyMs?: number
  errorCode?: string
  errorSnippet?: string
  retryAfterMs?: number
  /** Why this attempt rested (Phase 3): credit/quota/rate/verify/… */
  restReason?: string
  /** When the rest lifts, ms epoch (0/undefined = no rest). */
  restUntilMs?: number
  result: "opened" | "failed"
}

export type RequestOutcome = "success" | "incomplete" | "failed" | "cancelled"

/**
 * How a routing candidate fared. `chosen` is the one that answered; the rest
 * explain why they were passed over (lower priority, needs protocol
 * translation, a fallback wildcard, or temporarily unavailable).
 */
export type RouteCandidateStatus =
  | "chosen"
  | "available"
  | "translated"
  | "wildcard"
  | "cooldown"
  | "quota"
  | "auth"
  | "disabled"
  | "unknown"

/** One route the gateway could have taken for this request. */
export interface RouteCandidate {
  connectionId: string
  connectionName?: string
  provider?: string
  credentialId?: string
  credentialLabel?: string
  protocol?: string
  endpoint?: string
  model?: string
  priority?: number
  status: RouteCandidateStatus
  retryAfterMs?: number
  /**
   * Compact reason tag: the rest reason for resting candidates
   * (quota/rate/verify/…), the status token otherwise. Always set.
   */
  why?: string
  /** Share of the quota allowance used, 0..100. Undefined when unknown. */
  quotaUsedPct?: number
  /** Furthest quota renewal instant (biggest window), ms epoch. */
  renewAtMs?: number
  /** Tokens this (connection, credential) served lately (decayed). */
  servedTokens?: number
  /** Semantic rest reason when resting; refines `status`. */
  restReason?: string
  /** When the rest lifts, ms epoch. */
  restUntilMs?: number
  /** Group member spec when candidate belongs to a routing group. */
  member?: string
}
interface RequestLogError {
  origin: "client" | "admission" | "upstream" | "proxy" | "cancelled"
  kind: string
  message: string
  status?: number
  retryAfterMs?: number
}

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  message: string
  userId?: string
  username?: string
  accountId?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  latencyMs?: number
  requestBodyBytes?: number
  bodyReadMs?: number
  jsonDecodeMs?: number
  statusCode?: number
  path?: string
  error?: string
  diagnosticError?: RequestLogError
  errorType?: string
  errorSnippet?: string
  upstreamStatus?: number
  retryAfterMs?: number
  clientIp?: string
  userAgent?: string
  ttftMs?: number
  generationTps?: number
  streaming?: boolean
  wsCommitReason?: string
  wsBufferedEvents?: number
  wsBufferedBytes?: number
  finishReason?: string
  requestId?: string
  parentRequestId?: string
  method?: string
  endpoint?: LogEndpoint
  apiKind?: ApiKind
  stage?: TraceStage
  kind?: string
  ok?: boolean
  modelRequested?: string
  modelUpstream?: string
  /** 上游响应自报的模型名（未自报时缺省）。 */
  modelResponse?: string
  /** 上游自报模型与发往上游的模型真正不一致（归一化后仍不同）。 */
  modelMismatch?: boolean
  /** 上游自报模型与发往上游的模型仅差版本/日期/latest 后缀。 */
  modelVariant?: boolean
  /** 上游在同一次响应里先后声明了互相矛盾的模型名。 */
  modelConflict?: boolean
  /** 请求的思考等级（reasoning effort），来自模型名后缀或 payload 字段 */
  reasoningEffort?: string
  serviceTierRequested?: string
  serviceTierRouted?: string
  serviceTierUpstream?: string
  serviceTierResponse?: string
  provider?: string
  protocol?: string
  connectionId?: string
  connectionName?: string
  credentialId?: string
  credentialLabel?: string
  upstreamBaseUrl?: string
  isTranslated?: boolean
  isWildcard?: boolean
  initiator?: string
  sessionId?: string
  outcome?: RequestOutcome
  outputObserved?: boolean
  protocolTerminal?: string
  initialTarget?: string
  finalTarget?: string
  attempts?: Array<UpstreamAttempt>
  failoverCount?: number
  failoverReason?: string
  /** Candidate routes considered for this request, chosen first. */
  candidates?: Array<RouteCandidate>
  /** Routing group information when request hits a group. */
  routingGroupId?: string
  routingGroupName?: string
  routingGroupMembers?: Array<string>
  routingGroupSelectedMember?: string
  routingStrategy?: string
}

export type RequestLogRecord = Omit<LogEntry, "id">

const MAX_SIZE = Number(process.env["LOG_BUFFER_SIZE"] ?? 5000)

export interface LogQueryOptions {
  llmOnly?: boolean
  level?: LogLevel
  search?: string
  limit?: number
  offset?: number
  endpoint?: LogEndpoint
  apiKind?: ApiKind
  stage?: TraceStage
  ok?: boolean
  outcome?: RequestOutcome
  kind?: string
  provider?: string
  model?: string
  /** true 只看上游自报模型不一致的请求，false 只看一致的。 */
  modelMismatch?: boolean
  connectionId?: string
  requestId?: string
  statusMin?: number
  statusMax?: number
  hasError?: boolean
  streaming?: boolean
  timeFrom?: number
  timeTo?: number
}

class LogStore {
  private buffer: Array<LogEntry> = []
  private counter = 0

  push(entry: RequestLogRecord): void {
    if (this.buffer.length >= MAX_SIZE) this.buffer.shift()
    this.buffer.push({ id: ++this.counter, ...entry })
  }

  clearForTest(): void {
    this.buffer = []
    this.counter = 0
  }

  getById(requestId: string): LogEntry | undefined {
    return this.buffer.find((e) => e.requestId === requestId)
  }

  query(opts: LogQueryOptions): {
    entries: Array<LogEntry>
    filteredTotal: number
  } {
    let results = [...this.buffer].reverse()
    results = results.filter((entry) => matchesLogEntry(entry, opts))
    const filteredTotal = results.length
    const offset = opts.offset ?? 0
    const limit = Math.min(opts.limit ?? 100, 500)
    return { entries: results.slice(offset, offset + limit), filteredTotal }
  }

  count(): number {
    return this.buffer.length
  }

  todayCount(level?: LogLevel): number {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    return this.buffer.filter(
      (e) => e.timestamp >= startMs && (!level || e.level === level),
    ).length
  }
}

export function matchesLogEntry(
  entry: LogEntry,
  options: LogQueryOptions,
): boolean {
  if (options.llmOnly && !isLlmRequest(entry)) return false
  if (options.level && entry.level !== options.level) return false
  if (options.endpoint && entry.endpoint !== options.endpoint) return false
  if (options.apiKind && (entry.apiKind ?? entry.endpoint) !== options.apiKind)
    return false
  if (options.stage && entry.stage !== options.stage) return false
  if (
    options.kind
    && (entry.kind ?? "").toLowerCase() !== options.kind.toLowerCase()
  )
    return false
  if (options.ok !== undefined && Boolean(entry.ok) !== options.ok) return false
  if (options.outcome && entry.outcome !== options.outcome) return false
  if (
    options.provider
    && (entry.provider ?? "").toLowerCase() !== options.provider.toLowerCase()
  )
    return false
  if (options.model) {
    const model = options.model.toLowerCase()
    if (
      ![entry.model, entry.modelRequested, entry.modelUpstream].some((value) =>
        (value ?? "").toLowerCase().includes(model),
      )
    )
      return false
  }
  if (
    options.modelMismatch !== undefined
    && entry.modelMismatch !== options.modelMismatch
  )
    return false
  if (options.connectionId && entry.connectionId !== options.connectionId)
    return false
  if (
    options.requestId
    && ![entry.requestId, entry.parentRequestId].some((value) =>
      (value ?? "").toLowerCase().includes(options.requestId!.toLowerCase()),
    )
  )
    return false
  if (
    options.statusMin !== undefined
    && (entry.statusCode ?? 0) < options.statusMin
  )
    return false
  if (
    options.statusMax !== undefined
    && (entry.statusCode ?? 0) > options.statusMax
  )
    return false
  if (
    options.hasError !== undefined
    && Boolean(entry.error ?? entry.errorSnippet) !== options.hasError
  )
    return false
  if (
    options.streaming !== undefined
    && Boolean(entry.streaming) !== options.streaming
  )
    return false
  if (options.timeFrom !== undefined && entry.timestamp < options.timeFrom)
    return false
  if (options.timeTo !== undefined && entry.timestamp > options.timeTo)
    return false
  return (
    !options.search
    || JSON.stringify(entry)
      .toLowerCase()
      .includes(options.search.toLowerCase())
  )
}

export const logStore = new LogStore()
