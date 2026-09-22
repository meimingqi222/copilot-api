import type { Context } from "hono"

import { randomUUID } from "node:crypto"

import type {
  LogEntry,
  LogLevel,
  RequestLogRecord,
  UpstreamAttempt,
} from "~/lib/log-store"
import type {
  UpstreamModelObservation,
  UpstreamModelVerdict,
} from "~/lib/upstream-model-audit"

import {
  HTTPError,
  LocalConcurrencyLimitError,
  UpstreamTransportError,
} from "~/lib/error"
import { ProtectedRouteGuardError } from "~/lib/protected-route-guard"
import { classifyUpstreamError } from "~/lib/provider-connections/availability"
import {
  ClientAbortError,
  getKnownRouteErrorDetails,
} from "~/lib/request-lifecycle"
import { parseRetryAfterMs } from "~/lib/retry-after"
import { sanitizeDiagnosticSnippet } from "~/lib/security-sanitizer"
import {
  compareUpstreamModels,
  createUpstreamModelObservation,
  extractResponseModel,
  isTerminalResponseEvent,
  observeUpstreamModel,
  observedResponseModel,
  upstreamResponseSelfReportsModel,
} from "~/lib/upstream-model-audit"
import { isAbortError } from "~/lib/utils"

export type RequestEndpoint = LogEntry["endpoint"]
export type TraceStage = NonNullable<LogEntry["stage"]>
export interface RequestLogContext {
  requestId: string
  startMs: number
  entry: Partial<LogEntry>
  finished: boolean
  finish?: () => void
  /**
   * 上游响应自报模型的旁路观测器。惰性创建：只有真正观测到声明才分配。
   * 与 `entry.modelUpstream`（我们发出去的模型）配对，在 finalize 时比对。
   */
  upstreamModelObservation?: UpstreamModelObservation
}

const CTX_KEY = "requestLogCtx" as never
const REQ_ID_KEY = "requestId" as never

export function createDetachedRequestLog(
  entry: Partial<LogEntry> = {},
): RequestLogContext {
  const requestId = entry.requestId ?? randomUUID()
  return {
    requestId,
    startMs: Date.now(),
    entry: {
      timestamp: Date.now(),
      ...entry,
      requestId,
    },
    finished: false,
  }
}

export function bindRequestLogContext(
  c: Context,
  ctx: RequestLogContext,
): RequestLogContext | undefined {
  const previous = getRequestLogContext(c)
  c.set(CTX_KEY, ctx as never)
  c.set(REQ_ID_KEY, ctx.requestId)
  return previous
}

export function restoreRequestLogContext(
  c: Context,
  active: RequestLogContext,
  previous: RequestLogContext | undefined,
): void {
  if (getRequestLogContext(c) !== active) return
  c.set(CTX_KEY, previous as never)
  if (previous) c.set(REQ_ID_KEY, previous.requestId)
}

export function initRequestLog(
  c: Context,
  opts?: { parentRequestId?: string; requestId?: string },
): RequestLogContext {
  const requestId = opts?.requestId ?? randomUUID()
  const endpoint = inferEndpoint(c.req.path)
  const ctx: RequestLogContext = {
    requestId,
    startMs: Date.now(),
    entry: {
      requestId,
      parentRequestId: opts?.parentRequestId,
      timestamp: Date.now(),
      method: c.req.method,
      path: c.req.path,
      endpoint,
      apiKind: endpointToApiKind(endpoint),
    },
    finished: false,
  }
  c.set(REQ_ID_KEY, requestId)
  c.set(CTX_KEY, ctx as never)
  return ctx
}

export function getRequestLogContext(
  c: Context,
): RequestLogContext | undefined {
  return c.get(CTX_KEY) as RequestLogContext | undefined
}

export function patchRequestLog(c: Context, patch: Partial<LogEntry>): void {
  const ctx = getRequestLogContext(c)
  if (!ctx) return
  Object.assign(ctx.entry, patch)
  if (patch.requestId) ctx.requestId = patch.requestId
}

/**
 * 记录上游响应自报的模型名（旁路观测，绝不影响转发）。
 *
 * `payload` 是解析后的响应对象；`eventType` 是 SSE 事件名（流式），非流式传
 * undefined。所有协议都汇入这里，字段路径差异由 extractResponseModel 处理。
 */
export function observeUpstreamResponseModel(
  c: Context,
  payload: unknown,
  eventType?: string,
): void {
  observeUpstreamResponseModelForContext(
    getRequestLogContext(c),
    payload,
    eventType,
  )
}

/**
 * `observeUpstreamResponseModel` 的显式 context 版本。
 *
 * WS 路径自己管理 turn context 的绑定与恢复，这里直接传 `turnCtx` 比依赖
 * "调用时 c 恰好还绑在哪个 ctx 上"更可靠。
 */
export function observeUpstreamResponseModelForContext(
  ctx: RequestLogContext | undefined,
  payload: unknown,
  eventType?: string,
): void {
  if (!ctx) return
  const model = extractResponseModel(payload)
  if (!model) return
  const observation = (ctx.upstreamModelObservation ??=
    createUpstreamModelObservation())
  observeUpstreamModel(
    observation,
    model,
    isTerminalResponseEvent(eventType, payload),
  )
}

/** 从 SSE 事件的 data 字符串观测（流式路径的便捷入口）。 */
export function observeUpstreamResponseModelFromSseData(
  c: Context,
  data: string | undefined,
  eventType?: string,
): void {
  if (!data || data === "[DONE]") return
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  observeUpstreamResponseModel(c, parsed, eventType)
}

/**
 * 在请求收尾时结算观测结果：把上游自报模型与发出去的模型比对，写入
 * `modelResponse` / `modelMismatch` / `modelVariant`。
 *
 * 幂等：重复调用只结算一次。返回判定结果，供调用方决定是否提示。
 */
export function finalizeUpstreamModelAudit(
  c: Context,
): UpstreamModelVerdict | undefined {
  return finalizeUpstreamModelAuditForContext(getRequestLogContext(c))
}

/**
 * `finalizeUpstreamModelAudit` 的显式 context 版本。见
 * `observeUpstreamResponseModelForContext` 关于为何 WS 路径需要它。
 */
export function finalizeUpstreamModelAuditForContext(
  ctx: RequestLogContext | undefined,
): UpstreamModelVerdict | undefined {
  if (!ctx) return undefined
  if (ctx.entry.modelResponse !== undefined) {
    return (
      ctx.entry.modelMismatch ? "mismatch"
      : ctx.entry.modelVariant ? "variant"
      : "match"
    )
  }

  // 响应里的 model 是本适配器合成回显时（如 Windsurf）不结算：比对的是
  // 我们写进去的请求模型，而不是上游的自报，只会产生假阳性。见
  // `upstreamResponseSelfReportsModel`。观测器已经收下的声明同样丢弃，
  // 否则它会以 `modelResponse` 的形式留在日志里。
  if (!upstreamResponseSelfReportsModel(ctx.entry.protocol)) {
    ctx.upstreamModelObservation = undefined
    return undefined
  }

  const reported = observedResponseModel(ctx.upstreamModelObservation)
  if (!reported) return undefined

  // 发往上游的模型：渠道映射后的真实模型优先，回退请求模型。
  const sent =
    ctx.entry.modelUpstream?.trim()
    || ctx.entry.model?.trim()
    || ctx.entry.modelRequested?.trim()
  const verdict = sent ? compareUpstreamModels(sent, reported) : "match"

  Object.assign(ctx.entry, {
    modelResponse: reported,
    modelMismatch: verdict === "mismatch",
    modelVariant: verdict === "variant",
    // 上游在同一次响应里先后声明了不同的模型：这本身就是一个异常信号，
    // 与"我们发出去的模型是否一致"无关，所以单独记录（即使 verdict 是 match）。
    modelConflict: ctx.upstreamModelObservation?.conflict || undefined,
  })
  return verdict
}

export function addAttempt(c: Context, attempt: UpstreamAttempt): void {
  const ctx = getRequestLogContext(c)
  if (!ctx) return
  const list = (ctx.entry.attempts ??= [])
  if (list.length >= 20) return
  list.push({
    ...attempt,
    errorSnippet: sanitizeDiagnosticSnippet(attempt.errorSnippet),
  })
  ctx.entry.failoverCount = Math.max(0, list.length - 1)
  if (attempt.errorCode) ctx.entry.failoverReason = attempt.errorCode
}

export function recordUpstreamAttempt(
  c: Context | undefined,
  target: {
    connectionId: string
    connectionName?: string
    credentialId: string
    credentialLabel?: string
    endpoint: string
    protocol: string
    provider: string
    upstreamBaseUrl?: string
    upstreamModelId?: string
    isTranslated?: boolean
  },
  result: {
    status?: number
    latencyMs?: number
    errorCode?: string
    errorSnippet?: string
    retryAfterMs?: number
  },
  index: number,
): void {
  if (!c) return
  addAttempt(c, {
    n: index,
    connectionId: target.connectionId,
    connectionName: target.connectionName,
    credentialId: target.credentialId,
    credentialLabel: target.credentialLabel,
    endpoint: target.endpoint,
    protocol: target.protocol,
    provider: target.provider,
    upstreamBaseUrl: target.upstreamBaseUrl,
    status: result.status,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    errorSnippet: result.errorSnippet,
    retryAfterMs: result.retryAfterMs,
    result: result.errorCode ? "failed" : "opened",
  })
  const key = `${target.connectionId}/${target.credentialId}`
  const logCtx = getRequestLogContext(c)
  if (logCtx) {
    logCtx.entry.initialTarget ??= key
    logCtx.entry.finalTarget = key
    logCtx.entry.connectionId = target.connectionId
    if (target.connectionName)
      logCtx.entry.connectionName = target.connectionName
    logCtx.entry.credentialId = target.credentialId
    logCtx.entry.credentialLabel = target.credentialLabel
    logCtx.entry.provider = target.provider
    logCtx.entry.protocol = target.protocol
    logCtx.entry.upstreamBaseUrl = target.upstreamBaseUrl
    logCtx.entry.endpoint = target.endpoint as LogEntry["endpoint"]
    logCtx.entry.modelUpstream = target.upstreamModelId
    logCtx.entry.isTranslated = target.isTranslated
  }
}

export function recordTraceError(c: Context, error: unknown): void {
  const ctx = getRequestLogContext(c)
  if (ctx?.entry.diagnosticError) return
  const classified = classifyTraceError(
    error,
    Boolean(ctx?.entry.connectionId),
    c.req.raw.signal.aborted,
  )
  // 已定的终态（cancelled / failed）优先级高于这里的分类结果：
  // `markStreamTerminal` 已经根据协议终态或 signal 判过一次，后到的
  // 兜底分类不得把它覆盖回去（否则会出现 protocolTerminal=client_abort
  // 却 outcome=failed 这种自相矛盾的日志）。
  const settled = ctx?.entry.outcome
  const outcome: LogEntry["outcome"] =
    settled === "cancelled" || settled === "failed" ? settled
    : classified.stage === "abort" ? "cancelled"
    : "failed"
  patchRequestLog(c, {
    error: classified.message,
    errorType: classified.errorType,
    upstreamStatus: classified.upstreamStatus,
    retryAfterMs: classified.retryAfterMs,
    errorSnippet: sanitizeDiagnosticSnippet(classified.errorSnippet),
    outcome,
    diagnosticError: {
      origin:
        classified.stage === "abort" ? "cancelled"
        : classified.stage === "gate" ? "client"
        : classified.stage === "admission" ? "admission"
        : classified.stage === "upstream" ? "upstream"
        : "proxy",
      kind: classified.kind,
      message: truncate(classified.message, 500) ?? "Request failed",
      status: classified.upstreamStatus,
      retryAfterMs: classified.retryAfterMs,
    },
  })
}

function classifyTraceError(
  error: unknown,
  hasAdmission: boolean,
  clientSignalAborted: boolean,
): {
  stage: TraceStage
  kind: string
  message: string
  errorType: string
  upstreamStatus?: number
  retryAfterMs?: number
  errorSnippet?: string
} {
  if (error instanceof ClientAbortError) {
    return {
      stage: "abort",
      kind: "abort",
      message: "Client disconnected",
      errorType: "abort_error",
      upstreamStatus: 499,
    }
  }
  // 原生 AbortError（DOMException / undici 的 "The connection was closed."）
  // 也必须归为 abort：上游断开和客户端断开都经此路径，不认它就会掉进下面的
  // 兜底，被记成 origin=proxy / kind=unknown 的失败。
  //
  // 但裸 AbortError 也可能是**我们自己的超时**（AbortSignal.timeout、各类
  // 内部 controller.abort()），那不是客户端取消。只有客户端 signal 确实已
  // abort 时才判定为客户端断开；否则交给后续分支按真实原因归类。
  if (isAbortError(error) && clientSignalAborted) {
    return {
      stage: "abort",
      kind: "abort",
      message: errorMessage(error) ?? "Client disconnected",
      errorType: "abort_error",
      upstreamStatus: 499,
    }
  }
  if (error instanceof UpstreamTransportError) {
    return {
      stage: "upstream",
      kind: "transport",
      message: error.message,
      errorType: "transport_error",
      upstreamStatus: error.response.status,
      errorSnippet: truncate(error.responseBody, 2048),
    }
  }
  // A local pre-send gate rejection is NOT an upstream failure: classifying it
  // by status alone would land it in the generic HTTPError branch below and
  // label it `origin: upstream / kind: rate_limited`, contradicting the whole
  // point of the `local_saturation` scope (the credential is healthy, just
  // busy). `dispatch`/`proxy` is the correct story.
  if (error instanceof LocalConcurrencyLimitError) {
    // `retry-after-ms` is Anthropic-style milliseconds; `parseRetryAfterMs`
    // would read it as delta-seconds and inflate the value 1000×.
    const msHeader = error.response.headers.get("retry-after-ms")
    const parsedMs = msHeader ? Number.parseInt(msHeader, 10) : Number.NaN
    return {
      stage: "dispatch",
      kind: "concurrency_limit",
      message: error.message,
      errorType: "concurrency_limit",
      upstreamStatus: error.response.status,
      retryAfterMs:
        Number.isFinite(parsedMs) && parsedMs > 0 ?
          parsedMs
        : parseRetryAfterMs(error.response.headers.get("Retry-After")),
    }
  }
  if (error instanceof ProtectedRouteGuardError) {
    return {
      stage: "gate",
      kind: error.status === 429 ? "rate_limited" : "auth_error",
      message: error.message,
      errorType: error.errorType,
      upstreamStatus: error.status,
      retryAfterMs:
        error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined,
    }
  }
  const known = getKnownRouteErrorDetails(error)
  if (known) {
    return {
      stage: "gate",
      kind: known.type === "rate_limit_error" ? "rate_limited" : known.type,
      message: known.message,
      errorType: known.type,
      upstreamStatus: known.status,
      retryAfterMs:
        known.retryAfterSeconds ? known.retryAfterSeconds * 1000 : undefined,
    }
  }
  if (error instanceof HTTPError) {
    const status = error.response.status
    const body = error.responseBody
    const message = error.message.trim() || `Upstream HTTP ${status}`
    const isDoesNotSupport = /does not support/i.test(error.message + body)
    if (status === 499) {
      return {
        stage: "abort",
        kind: "abort",
        message: error.message || "Client disconnected",
        errorType: "abort_error",
        upstreamStatus: 499,
      }
    }
    if (status === 501 && isDoesNotSupport) {
      return {
        stage: "dispatch",
        kind: "dispatch_error",
        message,
        errorType: "dispatch_error",
        upstreamStatus: 501,
        errorSnippet: truncate(body, 2048),
      }
    }
    if (status === 401 || status === 403) {
      if (hasAdmission) {
        const classified = classifyUpstreamError({
          status,
          headers: error.response.headers,
          body,
        })
        return {
          stage: "upstream",
          kind: classified.kind === "unknown" ? "auth_error" : classified.kind,
          message,
          errorType: "auth_error",
          upstreamStatus: status,
          retryAfterMs: classified.retryAfterMs,
          errorSnippet: truncate(body, 2048),
        }
      }
      return {
        stage: "gate",
        kind: "auth_error",
        message,
        errorType: "auth_error",
        upstreamStatus: status,
        errorSnippet: truncate(body, 2048),
      }
    }
    if (!hasAdmission && (status === 400 || status === 404 || status === 422)) {
      return {
        stage: "client",
        kind: "client_error",
        message,
        errorType: "client_error",
        upstreamStatus: status,
        errorSnippet: truncate(body, 2048),
      }
    }
    if (status === 502 || status === 503) {
      if (hasAdmission) {
        const classified = classifyUpstreamError({
          status,
          headers: error.response.headers,
          body,
        })
        return {
          stage: "upstream",
          kind: classified.kind,
          message,
          errorType: classified.kind,
          upstreamStatus: status,
          retryAfterMs: classified.retryAfterMs,
          errorSnippet: truncate(body, 2048),
        }
      }
      return {
        stage: "dispatch",
        kind: "dispatch_error",
        message,
        errorType: "dispatch_error",
        upstreamStatus: status,
        errorSnippet: truncate(body, 2048),
      }
    }
    const classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body,
    })
    return {
      stage: "upstream",
      kind: classified.kind,
      message,
      errorType: classified.kind,
      upstreamStatus: status,
      retryAfterMs: classified.retryAfterMs,
      errorSnippet: truncate(body, 2048),
    }
  }
  return {
    stage: "dispatch",
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
    errorType: "dispatch_error",
  }
}

/** 安全的 message 读取：只接受非空字符串，避免把 undefined 塞进日志。 */
function errorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const message = error.message.trim()
  return message || undefined
}

export function finalizeRequestLog(
  c: Context,
  status: number,
): RequestLogRecord {
  const ctx = getRequestLogContext(c)
  return finalizeRequestLogContext(ctx, status, {
    method: c.req.method,
    path: c.req.path,
  })
}

export function finalizeRequestLogContext(
  ctx: RequestLogContext | undefined,
  status: number,
  defaults: { method: string; path: string; requestId?: string },
): RequestLogRecord {
  const base: Partial<LogEntry> & { requestId: string } =
    ctx ?
      { ...ctx.entry, requestId: ctx.requestId }
    : { requestId: defaults.requestId ?? randomUUID() }

  const latencyMs =
    base.latencyMs ?? (ctx ? Date.now() - ctx.startMs : undefined)
  const level: LogLevel =
    status >= 500 ? "error"
    : status >= 400 ? "warn"
    : "info"

  const error = truncate(base.error, 2000)
  const errorSnippet = sanitizeDiagnosticSnippet(base.errorSnippet)

  const outcome =
    base.outcome
    ?? (status === 499 ? "cancelled"
    : status >= 400 ? "failed"
    : base.streaming ? "incomplete"
    : "success")
  return {
    ...base,
    timestamp: base.timestamp ?? Date.now(),
    level: base.level ?? level,
    message:
      base.message
      ?? `${base.method ?? defaults.method} ${base.path ?? defaults.path} ${status}`,
    statusCode: status,
    latencyMs,
    error,
    errorSnippet,
    outcome,
    apiKind: base.apiKind ?? endpointToApiKind(base.endpoint),
  } as RequestLogRecord
}

export function beginStreamLog(c: Context): void {
  patchRequestLog(c, { streaming: true, outcome: "incomplete" })
}

export function markStreamTerminal(
  c: Context,
  terminal: string,
  outcome: LogEntry["outcome"],
  outputObserved?: boolean,
): void {
  const ctx = getRequestLogContext(c)
  const existingOutcome = ctx?.entry.outcome
  patchRequestLog(c, {
    protocolTerminal: terminal,
    outcome:
      existingOutcome === "failed" || existingOutcome === "cancelled" ?
        existingOutcome
      : outcome,
    outputObserved,
  })
}

export function claimRequestLogFinish(c: Context): boolean {
  const ctx = getRequestLogContext(c)
  if (!ctx || ctx.finished) return false
  ctx.finished = true
  return true
}

export function setRequestLogFinisher(c: Context, finish: () => void): void {
  const ctx = getRequestLogContext(c)
  if (ctx) ctx.finish = finish
}

export function finishRequestLog(c: Context): void {
  getRequestLogContext(c)?.finish?.()
}

export function inferEndpoint(path: string): RequestEndpoint {
  if (
    path === "/chat/completions"
    || path === "/v1/chat/completions"
    || path.startsWith("/chat/completions/")
    || path.startsWith("/v1/chat/completions/")
  )
    return "chat"
  if (path === "/v1/messages" || path.startsWith("/v1/messages"))
    return "messages"
  if (
    path === "/responses"
    || path === "/v1/responses"
    || path.startsWith("/responses/")
    || path.startsWith("/v1/responses/")
  )
    return "responses"
  if (
    path === "/embeddings"
    || path === "/v1/embeddings"
    || path.startsWith("/embeddings")
    || path.startsWith("/v1/embeddings")
  )
    return "embeddings"
  if (path.startsWith("/v1/images") || path.startsWith("/images"))
    return "images"
  if (path.startsWith("/v1/videos") || path.startsWith("/videos"))
    return "videos"
  if (
    path === "/v1/models"
    || path === "/models"
    || path.startsWith("/models")
    || path.startsWith("/v1/models")
  )
    return "other"
  return "other"
}

function endpointToApiKind(
  endpoint: RequestEndpoint | undefined,
): LogEntry["apiKind"] {
  if (
    endpoint === "chat"
    || endpoint === "messages"
    || endpoint === "responses"
    || endpoint === "embeddings"
  )
    return endpoint
  return "other"
}

export function isCoreApiPath(path: string): boolean {
  return (
    path === "/chat/completions"
    || path.startsWith("/chat/completions/")
    || path === "/v1/chat/completions"
    || path.startsWith("/v1/chat/completions/")
    || path === "/v1/messages"
    || path.startsWith("/v1/messages/")
    || path === "/v1/messages/count_tokens"
    || path === "/responses"
    || path.startsWith("/responses/")
    || path === "/v1/responses"
    || path.startsWith("/v1/responses/")
    || path === "/embeddings"
    || path.startsWith("/embeddings/")
    || path === "/v1/embeddings"
    || path.startsWith("/v1/embeddings/")
  )
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value
  return value.length > max ? value.slice(0, max) : value
}
