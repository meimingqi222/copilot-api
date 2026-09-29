/**
 * OpenAI Chat Completions 兼容上游的通用请求体归一化。
 *
 * 这里每一条改写都是**语义无损**的（角色同义、字段形状等价、只丢弃无法重放
 * 的碎片），但对"严格后端"是必需的：上游遇到不认识的形状时往往只回一个笼统
 * 的 5xx（如 LobsterAI 的 `{"code":500,"message":"服务器内部错误"}`）或 400
 * 业务码，客户端看到的就是"这条会话突然全崩"，且没有任何线索。
 *
 * 实测证据（2026-09-29，LobsterAI 上游 /api/proxy/v1/chat/completions，
 * 形状 × 模型矩阵）：
 *
 * | 形状                                  | deepseek-* | glm/kimi/qwen |
 * | ------------------------------------- | ---------- | ------------- |
 * | `role: "developer"`                   | 500        | 200           |
 * | `tool_choice` 对象形式                 | 500*       | 200           |
 * | 孤儿 tool_call / tool 结果、id 不匹配  | 500        | 200           |
 * | tool_call 与结果之间插入其它消息        | 500*       | 200           |
 * | `image_url` 裸字符串                   | 500        | 200           |
 * | assistant `content: null`（无 tool_calls） | 500    | 200           |
 *
 * （\* 仅 deepseek-flash 复现；deepseek-v4-flash / v4-pro 接受这两项。）
 *
 * 另外 `max_completion_tokens` 会被上游**静默忽略**并回落默认输出上限：
 * 传 `max_completion_tokens: 8` 时 deepseek-flash 跑满 140 tokens、glm-5.2
 * 跑满 117 tokens 才 stop，而 `max_tokens: 8` 正常在 8 tokens 截断。
 *
 * CodeBuddy 上游（`codebuddy-native`）对角色、tool_choice 形状、image_url 形状
 * 与 tool 配对同样敏感（业务码 11-128 / 11101 / 11148），所以两边共用本模块；
 * 差异化的部分（CodeBuddy 的风控指纹清洗、deepseek thinking 注入、模型级限流
 * 冷却）留在各自 adapter 里。
 *
 * 同一代理后面的真实后端会变（deepseek-flash 就比 deepseek-v4-flash 严格），
 * 因此这里**不按模型名 gate**，一律归一化。
 */

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

// ── 角色 ────────────────────────────────────────────────────────────

/**
 * 把 OpenAI 新版 `developer` 角色归一化为 `system`。
 *
 * CodeBuddy 上游直接返回 11-128（Illegal API invocation from an unapproved
 * channel）；LobsterAI 的 deepseek 系后端返回 500。两者对 `system` 都正常，
 * 且 `developer` 本就是 `system` 的新名字，改写不损失语义。
 */
export function normalizeCompatRoles(
  messages: ChatCompletionsPayload["messages"],
): void {
  for (const message of messages) {
    if (message.role === "developer") {
      message.role = "system"
    }
  }
}

// ── 请求体字段 ──────────────────────────────────────────────────────

/**
 * `tool_choice` 归一化为字符串（部分上游该字段只认 string）：
 *   - `"none"` / `{"type":"none"}` → 删 `tool_choice` + 删 `tools`/`functions`
 *   - `{"type":"auto"/"required"}` → 字符串 `"auto"`/`"required"`
 *   - `{"type":"function","function":{"name":"x"}}` → 字符串 `"x"`
 *   - 其它对象 / 非标量 → 删 `tool_choice`
 */
export function normalizeCompatToolChoice(
  payload: Record<string, unknown>,
): void {
  if (!("tool_choice" in payload)) return
  const suppressTools = () => {
    delete payload.tools
    delete payload.functions
  }
  const tc = payload.tool_choice
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete payload.tool_choice
      suppressTools()
    }
    return
  }
  if (tc && typeof tc === "object") {
    const v = tc as Record<string, unknown>
    const typ = typeof v.type === "string" ? v.type.trim().toLowerCase() : ""
    switch (typ) {
      case "none": {
        delete payload.tool_choice
        suppressTools()
        return
      }
      case "auto":
      case "required": {
        payload.tool_choice = typ
        return
      }
      case "function": {
        const fn = v.function as Record<string, unknown> | undefined
        let name =
          typeof fn?.name === "string" ? fn.name
          : typeof v.name === "string" ? v.name
          : ""
        name = name.trim()
        payload.tool_choice = name || "auto"
        return
      }
      default: {
        delete payload.tool_choice
        return
      }
    }
  }
  delete payload.tool_choice
}

/**
 * OpenAI 新字段 `max_completion_tokens` → 上游只认的 `max_tokens`。
 *
 * 别名透传会被上游**静默忽略**（不报错）并回落默认输出上限，长输出任务被
 * 截断且无任何提示。显式 `max_tokens` 优先（别名只删不译）；`0`/`null`/负数/
 * 非整数不翻译，避免把"无上限"意图写成 0。
 */
export function translateCompatMaxCompletionTokens(
  payload: Record<string, unknown>,
): void {
  if (!("max_completion_tokens" in payload)) return
  const alias = payload.max_completion_tokens
  delete payload.max_completion_tokens
  if (payload.max_tokens != null) return
  if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) {
    payload.max_tokens = alias
  }
}

/**
 * `image_url` 归一化为对象形态 `{"url": "..."}`。
 *
 * 部分客户端（和部分 OpenAI SDK 版本）发字符串形态，严格上游直接拒绝。
 * 仅做形状转换，不补默认值、不校验内容。
 */
export function normalizeCompatImageUrls(messages: Array<Message>): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as unknown as Array<
      Record<string, unknown>
    >) {
      if (part?.type !== "image_url") continue
      if (typeof part.image_url === "string" && part.image_url) {
        part.image_url = { url: part.image_url }
      }
    }
  }
}

/**
 * 补空 assistant 消息的 `content: null` → `""`。
 *
 * OpenAI 兼容上游普遍要求 `content` 是字符串；LobsterAI 的 deepseek 系后端对
 * "`content: null` 且没有 tool_calls"的 assistant 消息直接 500，而 `""`/`[]`
 * 都正常。带 tool_calls 的 `content: null` 是合法形态（实测可通过），保持原样。
 */
export function fillCompatNullAssistantContent(messages: Array<Message>): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    if (msg.content !== null) continue
    if (msg.tool_calls?.length) continue
    msg.content = ""
  }
}

// ── tool_call ↔ tool 配对 ───────────────────────────────────────────

/**
 * 把插在 `assistant.tool_calls` 与其 tool 结果之间的非 tool 消息挪到整组之后，
 * 保证同一批 tool_call 的结果在 wire 上连续。
 *
 * OpenAI 兼容协议要求 tool 结果紧跟 assistant；中间插任何消息（如 Codex 的
 * image_resize_notice）都算配对断裂，CodeBuddy 判 11148、LobsterAI 的
 * deepseek 系后端直接 500，并顶死整条会话。
 */
export function repackCompatToolResults(
  messages: Array<Message>,
): Array<Message> {
  if (messages.length < 3) return messages
  const out: Array<Message> = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.role !== "assistant" || !m.tool_calls?.length) {
      out.push(m)
      i++
      continue
    }
    const want = new Set(
      m.tool_calls.map((tc) => tc.id).filter((id) => id !== ""),
    )
    out.push(m)
    i++
    const results: Array<Message> = []
    const between: Array<Message> = []
    let sawNonTool = false
    while (i < messages.length) {
      const mm = messages[i]
      if (mm.role === "tool") {
        if (!want.has(mm.tool_call_id ?? "")) break
        results.push(mm)
        if (sawNonTool) changed = true
        i++
        continue
      }
      if (results.length === 0) break
      // 下一组 assistant.tool_calls 是新组头，不能当插入物吞掉。
      if (mm.role === "assistant" && mm.tool_calls?.length) break
      between.push(mm)
      sawNonTool = true
      i++
    }
    out.push(...results, ...between)
  }
  return changed ? out : messages
}

/**
 * 剔除无法配对的 tool_call 与 tool 结果（按 id 对称裁剪）。
 *
 * 缺任一侧上游都拒绝整个请求：工具执行失败/被中断后，客户端把无结果的
 * tool_calls 持久化进历史并每次重放，于是之后每条消息都失败、整条会话报废。
 * 宁可丢一轮工具上下文，也好过会话死亡。
 */
export function pruneCompatOrphanToolCalls(
  messages: Array<Message>,
): Array<Message> {
  const callIDs = new Set<string>()
  const resultIDs = new Set<string>()
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      resultIDs.add(m.tool_call_id)
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callIDs.add(tc.id)
      }
    }
  }
  if (callIDs.size === 0 && resultIDs.size === 0) return messages

  const keepCalls = new Set<string>()
  for (const id of callIDs) {
    if (resultIDs.has(id)) keepCalls.add(id)
  }

  let changed = false
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls?.length) continue
    const kept = m.tool_calls.filter((tc) => tc.id && keepCalls.has(tc.id))
    if (kept.length === m.tool_calls.length) continue
    changed = true
    if (kept.length === 0) {
      delete m.tool_calls
    } else {
      m.tool_calls = kept
    }
  }
  const kept = messages.filter((m) => {
    if (m.role !== "tool") return true
    if (!keepCalls.has(m.tool_call_id ?? "")) {
      changed = true
      return false
    }
    return true
  })
  return changed ? kept : messages
}

// ── 编排 ────────────────────────────────────────────────────────────

/**
 * 克隆并一次性应用全部通用归一化，返回**新** payload。
 *
 * 克隆是必须的：messages/tools 与调用方的 payload 共享引用，原地改写会污染
 * 上层用于 failover 重试的原始请求体（`tests/codebuddy-provider.test.ts` 有
 * 对应回归用例）。上游特有的改写（CodeBuddy 的风控清洗与 thinking 注入）
 * 由各自 adapter 在这个返回值上继续做。
 */
export function normalizeOpenAICompatChatPayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const normalized: ChatCompletionsPayload = {
    ...payload,
    messages: structuredClone(payload.messages),
    ...(payload.tools ? { tools: structuredClone(payload.tools) } : {}),
  }
  const raw = normalized as unknown as Record<string, unknown>

  translateCompatMaxCompletionTokens(raw)
  normalizeCompatToolChoice(raw)
  normalizeCompatRoles(normalized.messages)
  normalizeCompatImageUrls(normalized.messages)
  fillCompatNullAssistantContent(normalized.messages)
  normalized.messages = pruneCompatOrphanToolCalls(
    repackCompatToolResults(normalized.messages),
  )
  return normalized
}
