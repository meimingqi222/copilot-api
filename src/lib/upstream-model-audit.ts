/**
 * 上游响应模型审计。
 *
 * 有些上游会在响应里自报它实际使用的模型名（OpenAI Responses 的
 * `response.model`、Chat Completions 的 `model`、Anthropic 的
 * `message.model`、Gemini 的 `modelVersion`）。把它和我们**真正发出去**的
 * 模型名比一比，就能发现"请求 A 上游却用了 B"这类静默降级/串号。
 * 结算时（`finalizeUpstreamModelAuditForContext`）会同时比对用户原始请求的
 * 模型名：用户主动定义的别名（upstreamId 缩写、全局别名规则）会让"发出去"
 * 与"请求的"不同，而上游回显的往往是它自己的规范 id（恰好等于请求的），
 * 这种情况属于预期的别名展开，不告警。
 *
 * 设计约束（与 sub2api 的 `upstream_response_model.go` 对齐，但只做观测）：
 * - **纯旁路**：观测绝不改动转发路径，解析失败一律当作"未观测"。
 * - **三态**：上游没自报模型时结果为空（不判定），而不是判定为一致。
 * - **只读不猜**：不做模糊匹配，唯一例外是一张显式的 runtime-id 别名表
 *   （见 `canonicalRuntimeModelAlias`），因为那是已确认的上游行为而非猜测。
 *
 * 接入点（共两处，因为存在两条互不相交的收尾路径）：
 * - HTTP 路由：`services/dispatch/shared.ts` 的 `decorateResult` 观测，
 *   `lib/log-middleware.ts` 的 finalize 结算。覆盖 chat / messages /
 *   responses 及其全部跨协议翻译路径。
 * - Responses WebSocket：`routes/responses/ws-handler.ts` 自己观测（pump 只
 *   回传终态）并自己结算（它用 detached turn ctx，不走 log-middleware）。
 *
 * 结算前先过 `upstreamResponseSelfReportsModel`：响应里的 model 若是适配器
 * 自己合成回显的（Windsurf），比对的是我们写进去的请求模型而不是上游自报，
 * 必须整条跳过，否则只会产生假阳性。
 *
 * 刻意**未**接入的两条路径（已核实，不是遗漏）：
 * - chat→responses 流式翻译：`updateChatToResponsesStateFromChunk` 每个 chunk
 *   都刷新 `state.model`，终态 `response.completed.response.model` 已经是上游
 *   真实模型，无需重复观测。
 * - embeddings：响应确实带 `model`，但它走独立路由且静默换模型不改变输出
 *   语义，观测收益不足以抵掉一条接线。
 */

/** 上游自报模型名的长度上限，防止上游塞超长字符串污染日志。 */
const MAX_OBSERVED_MODEL_LENGTH = 200

/**
 * 上游是否会在响应体里自报它实际服务的模型名。
 *
 * 审计的前提是"响应里的 model 字段来自上游"。有些适配器的响应模型是我们
 * 自己合成的本地回显，审计它只会产生假阳性，必须显式排除：
 *
 * - `windsurf-native`：Windsurf 的 protobuf 帧里没有模型字段，响应里的
 *   `model` 由 `windsurf/chunk-builders.ts` / `windsurf/collect-response.ts`
 *   用**请求模型**写入。而 Windsurf 把思考等级编码成不同的 SKU（折叠后的
 *   头 `swe-2` → `swe-2-high` / `swe-2-medium` / `swe-2-max`），适配器按
 *   `reasoning_effort` 选出的真实 SKU 会覆盖 `modelUpstream`。于是"本地
 *   回显的头"与"真正发出去的 SKU"天然不同（`swe-2` vs `swe-2-high`），
 *   这是上游的既定形态而不是静默换模型。
 *
 * 未列入的协议都按"上游会自报"处理。
 */
export function upstreamResponseSelfReportsModel(
  protocol: string | undefined,
): boolean {
  return protocol !== "windsurf-native"
}

export interface UpstreamModelObservation {
  /** 第一个非 terminal 声明。 */
  first?: string
  /** terminal 事件的声明，优先级最高。 */
  terminal?: string
  /** 多次声明互相矛盾（大小写不敏感比较）。 */
  conflict: boolean
}

/** 判定结果：一致 / 仅版本变体 / 真正不一致。 */
export type UpstreamModelVerdict = "match" | "variant" | "mismatch"

export function createUpstreamModelObservation(): UpstreamModelObservation {
  return { conflict: false }
}

/**
 * terminal 事件（一个 turn 的收尾）里的模型名最可信；没有 terminal 时保留
 * 首个声明。后到的声明与当前选择不同即标记 conflict，但仍保留选择结果。
 */
export function observeUpstreamModel(
  observation: UpstreamModelObservation,
  model: string | undefined,
  terminal: boolean,
): void {
  const normalized = normalizeObservedModel(model)
  if (!normalized) return

  const current = observedResponseModel(observation)
  if (current && !isSameModelSpelling(current, normalized)) {
    observation.conflict = true
  }
  if (terminal) {
    observation.terminal = normalized
    return
  }
  observation.first ??= normalized
}

export function observedResponseModel(
  observation: UpstreamModelObservation | undefined,
): string | undefined {
  if (!observation) return undefined
  return observation.terminal ?? observation.first
}

/**
 * 从任意协议的响应 payload 里抽出自报模型名。
 *
 * 取值顺序覆盖本仓库所有翻译层保留的字段位置（翻译层会保留上游的 model
 * 字段，所以这里不需要知道目标协议）：
 *   response.model  → Responses API / responses-via-chat
 *   model           → Chat Completions / 翻译后的 chunk
 *   message.model   → Anthropic Messages
 *   modelVersion    → Gemini（含 antigravity 包装层）
 */
export function extractResponseModel(payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (!record) return undefined

  // `model` 与 `response.model` 是 OpenAI 两种形状；`message.model` 是
  // Anthropic；`modelVersion` 是 Gemini（含 antigravity 包装层）。
  // 统一规则：外层优先于内层；同一层内先查 `model` 再查 `modelVersion`。
  const direct =
    readString(record, "model") ?? readString(record, "modelVersion")
  if (direct) return direct

  const message = asRecord(record["message"])
  if (message) {
    const nested = readString(message, "model")
    if (nested) return nested
  }

  const response = asRecord(record["response"])
  if (response) {
    const nested =
      readString(response, "model") ?? readString(response, "modelVersion")
    if (nested) return nested
    const doubleNested = asRecord(response["response"])
    if (doubleNested) {
      const deep = readString(doubleNested, "modelVersion")
      if (deep) return deep
    }
  }

  return undefined
}

/**
 * terminal 事件判定。
 *
 * 优先用 SSE 的 `event:` 行；但它经常不存在——真实 Copilot Responses SSE 把
 * 类型放在 JSON body 的 `type` 字段里，而 `fetch-event-stream` 只在存在字面
 * `event:` 行时才填充 `event.event`。所以 eventType 缺失时回退到 body 的
 * `type`。不回退的话 `response.completed` 会被当成非 terminal，审计就会
 * 采信 `response.created` 里的请求回显模型，把真正的终态模型丢掉。
 *
 * body 连 `type` 都没有时（非流式 body、Gemini chunk）按 terminal 处理：
 * 那种载荷每次出现都携带最终信息，保留最后一个声明。
 */
export function isTerminalResponseEvent(
  eventType: string | undefined,
  payload: unknown,
): boolean {
  const type = eventType?.trim() || readString(asRecord(payload), "type")
  if (type) {
    switch (type) {
      case "response.completed":
      case "response.done":
      case "response.failed":
      case "response.incomplete":
      case "response.cancelled":
      case "response.canceled":
      case "message_stop": {
        return true
      }
      default: {
        return false
      }
    }
  }
  return true
}

/**
 * 比较"发往上游的模型"与"上游自报的模型"。
 *
 * 分三档，越往下信号越强：
 * - `match`：同一模型。包含大小写差异、供应商路径前缀、思考等级后缀，
 *   以及 xAI grok runtime build ID 这类已确认的上游别名。
 * - `variant`：归一化后相同，只差日期快照或 `-latest` 浮动标签
 *   （`claude-sonnet-4-20250514` vs `claude-sonnet-4`）。信息性提示。
 * - `mismatch`：其余全部，即上游真的换了模型。
 */
export function compareUpstreamModels(
  sentModel: string,
  reportedModel: string,
): UpstreamModelVerdict {
  const sent = sentModel.trim()
  const reported = reportedModel.trim()
  if (!sent || !reported) return "match"

  // 身份级归一化：路径前缀 / effort 后缀都不改变模型身份。
  const sentIdentity = normalizeModelIdentity(sent)
  const reportedIdentity = normalizeModelIdentity(reported)
  if (sentIdentity && sentIdentity === reportedIdentity) return "match"

  const sentRuntime = canonicalRuntimeModelAlias(sentIdentity)
  if (
    sentRuntime
    && (sentRuntime === canonicalRuntimeModelAlias(reportedIdentity)
      || sentRuntime === reportedIdentity)
  ) {
    return "match"
  }
  const reportedRuntime = canonicalRuntimeModelAlias(reportedIdentity)
  if (reportedRuntime && reportedRuntime === sentIdentity) return "match"

  // 版本级归一化：只差日期快照 / `-latest` 才是"疑似版本变体"。
  return normalizeModelForAudit(sent) === normalizeModelForAudit(reported) ?
      "variant"
    : "mismatch"
}

/**
 * xAI 对 `grok-4.x` 系列公开别名会回报 runtime build ID（如
 * `grok-4.6-build`）。这是已确认的上游行为，单独归一化，避免把它当成串号。
 * 只做 mismatch 审计用，展示仍保留上游原始字符串。
 */
export function canonicalRuntimeModelAlias(model: string): string | undefined {
  switch (normalizeModelIdentity(model)) {
    case "grok-4.5":
    case "grok-4.5-latest":
    case "grok-4.5-build": {
      return "grok-4.5-build"
    }
    case "grok-4.6":
    case "grok-4.6-latest":
    case "grok-4.6-build": {
      return "grok-4.6-build"
    }
    default: {
      return undefined
    }
  }
}

function isSameModelSpelling(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * 身份级归一化：只去掉**确定不改变模型身份**的部分。
 *
 * - 供应商路径前缀（`openai/gpt-5.5` → `gpt-5.5`）
 * - 思考等级后缀（`gpt-5.5(high)` → `gpt-5.5`）
 *
 * 刻意保留日期快照与 `-latest`：那是版本差异，由 `normalizeModelForAudit`
 * 处理成 `variant` 而非 `match`。
 */
export function normalizeModelIdentity(model: string): string {
  let value = model.trim().toLowerCase()
  if (!value) return ""

  const slash = value.lastIndexOf("/")
  if (slash !== -1) value = value.slice(slash + 1)

  const paren = value.lastIndexOf("(")
  if (paren > 0 && value.endsWith(")")) {
    value = value.slice(0, paren).trim()
  }

  return value
}

/**
 * 版本级归一化：在身份级之上再去掉日期快照与 `-latest` 浮动标签。
 *
 * 刻意**不**去掉任意 `-xxx` 后缀：`gpt-5.5` 与 `gpt-5.5-build` 是不同模型，
 * 必须判为 mismatch（sub2api 的测试同样锁定了这一点）。
 */
export function normalizeModelForAudit(model: string): string {
  return normalizeModelIdentity(model)
    .replace(/[-_]\d{4}-\d{2}-\d{2}$/, "")
    .replace(/[-_]\d{8}$/, "")
    .replace(/-latest$/, "")
}

function normalizeObservedModel(model: string | undefined): string | undefined {
  if (typeof model !== "string") return undefined
  const trimmed = model.trim()
  if (!trimmed) return undefined
  const runes = [...trimmed]
  return runes.length > MAX_OBSERVED_MODEL_LENGTH ?
      runes.slice(0, MAX_OBSERVED_MODEL_LENGTH).join("")
    : trimmed
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}
