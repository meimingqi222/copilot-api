/**
 * OpenAI chat payload → Qoder `agent_chat_generation` 明文封套。
 *
 * 明文封套形状：
 *
 *   {
 *     parameters: { enable_thinking, max_tokens, reasoning_effort?, context_length? },
 *     business: { product, version, type, id, name, begin_at, stage },
 *     agent_id: "agent_common",
 *     task_id: "common",
 *     session_type: "app",
 *     model_config: <model/list 原始配置>,
 *     system: [{ type: "text", text }],
 *     messages: [{ role: "system", content: [...] }, ...],
 *     tools?: [...]
 *   }
 *
 * 返回值是 JSON 字符串，交给 codec.encodeRequestBody 编码成 wire body。
 */

import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import { QODER_COSY_VERSION } from "./endpoints"
import { newQoderId } from "./ids"

/** 一条 Qoder 模型配置（来自 model/list，见 Stage 3 的 models.ts）。 */
export interface QoderModelInfo {
  key: string
  source: string
  maxInputTokens: number
  thinks: boolean
  alwaysThinks: boolean
  defaultEffort: string
  efforts: Array<string>
  /** model/list 中该条目的原始配置，作为 `model_config` 原样回传。 */
  config: unknown
}

/** effort 顺序（含 none / ultra）。 */
const EFFORT_RANK = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]

const QODER_SYS =
  "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."

const DEFAULT_MAX_TOKENS = 32000

/** fitEffort：取模型自身最接近所要求的那一档；平局往上取。 */
function fitEffort(want: string, levels: Array<string>): string {
  if (want === "ultra" && !levels.includes(want)) {
    want = "max"
  }
  if (levels.length === 0 || levels.includes(want)) {
    return want
  }
  const at = EFFORT_RANK.indexOf(want)
  if (at < 0) {
    return want
  }
  let best = want
  let dist = EFFORT_RANK.length
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) {
      best = l
      dist = d
    }
  }
  return best
}

/**
 * qoderEffort：是否思考、以及用模型自身的哪一档 effort（"" 表示不发）。
 * 被要求 none 而模型总是思考时，用它的最低档；没被要求或要求了模型没有的档位时，
 * 用模型自己的默认档。
 */
function qoderEffort(
  asked: string,
  model: QoderModelInfo,
): { thinking: boolean; effort: string } {
  let want = asked.toLowerCase()
  if (!EFFORT_RANK.includes(want)) {
    want = ""
  }
  if (!model.thinks || (want === "none" && !model.alwaysThinks)) {
    return { thinking: false, effort: "" }
  }
  if (model.efforts.length === 0) {
    return { thinking: true, effort: "" }
  }
  switch (want) {
    case "":
      return { thinking: true, effort: model.defaultEffort }
    case "none":
      return { thinking: true, effort: model.efforts[0] }
    default:
      return { thinking: true, effort: fitEffort(want, model.efforts) }
  }
}

function isSystemRole(role: string): boolean {
  return role === "system" || role === "developer"
}

/** 把文本类 content part 连成一段字符串。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    const part = p as { type?: string; text?: unknown }
    if (
      (part.type === "text" || part.type === "output_text")
      && typeof part.text === "string"
    ) {
      parts.push(part.text)
    }
  }
  return parts.join("")
}

/** content → Qoder 的 content 块数组（text / image_url）。 */
function blocksOf(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const out: Array<Record<string, unknown>> = []
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    const part = p as { type?: string; text?: unknown; image_url?: unknown }
    if (
      (part.type === "text" || part.type === "output_text")
      && typeof part.text === "string"
    ) {
      out.push({ type: "text", text: part.text })
    } else if (part.type === "image_url" && part.image_url) {
      out.push({ type: "image_url", image_url: part.image_url })
    }
  }
  return out
}

function qoderTools(
  tools: NonNullable<ChatCompletionsPayload["tools"]>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const t of tools) {
    const fn = t.function
    let schema = fn.parameters
    if (
      !schema
      || typeof schema !== "object"
      || Object.keys(schema).length === 0
    ) {
      schema = { type: "object", properties: {} }
    }
    out.push({
      type: "function",
      function: {
        name: fn.name,
        description: fn.description,
        parameters: schema,
      },
    })
  }
  return out
}

/** 调用方的消息 → Qoder 消息（system 单独折叠进 system 字段）。 */
function qoderMessages(
  messages: ChatCompletionsPayload["messages"],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (isSystemRole(m.role)) continue
    if (m.role === "tool") {
      const text = textOf(m.content)
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id ?? "",
        content: text,
      })
      continue
    }
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => ({
        id: c.id || `call_${newQoderId()}`,
        type: "function",
        function: { name: c.function.name, arguments: c.function.arguments },
      }))
      if (calls.length > 0) {
        out.push({
          role: "assistant",
          content: textOf(m.content),
          tool_calls: calls,
        })
        continue
      }
      out.push({ role: "assistant", content: blocksOf(m.content) })
      continue
    }
    out.push({ role: m.role, content: blocksOf(m.content) })
  }
  return out
}

/** system / developer 消息的文本，按出现顺序拼接。 */
function collectSystem(messages: ChatCompletionsPayload["messages"]): string {
  const parts: Array<string> = []
  for (const m of messages) {
    if (isSystemRole(m.role)) {
      const t = textOf(m.content)
      if (t) parts.push(t)
    }
  }
  return parts.join("\n\n")
}

/** 系统提示：Qoder 自己的那一行 + 调用方的。 */
function qoderSysText(
  callerSystem: string,
  toolChoice: ChatCompletionsPayload["tool_choice"],
  hasTools: boolean,
): string {
  let sys = QODER_SYS
  if (callerSystem) {
    sys = `${sys}\n\n${callerSystem}`
  }
  if (toolChoice === "required" && hasTools) {
    sys += "\nYou must call an available function in this response."
  }
  return sys
}

/** 构造 agent_chat_generation 的明文 JSON body。 */
export function buildChatEnvelope(
  payload: ChatCompletionsPayload,
  model: QoderModelInfo,
): string {
  if (!model.key || model.config === undefined || model.config === null) {
    throw new Error("Qoder: missing model configuration")
  }
  const tools = payload.tools ?? []
  const sys = {
    type: "text",
    text: qoderSysText(
      collectSystem(payload.messages),
      payload.tool_choice,
      tools.length > 0,
    ),
  }
  const { thinking, effort } = qoderEffort(
    payload.reasoning_effort ?? "",
    model,
  )
  const maxTok =
    typeof payload.max_tokens === "number" && payload.max_tokens > 0 ?
      payload.max_tokens
    : DEFAULT_MAX_TOKENS
  const parameters: Record<string, unknown> = {
    enable_thinking: thinking,
    max_tokens: maxTok,
  }
  if (effort) {
    parameters.reasoning_effort = effort
  }
  if (model.maxInputTokens > 0) {
    parameters.context_length = model.maxInputTokens
  }

  const body: Record<string, unknown> = {
    parameters,
    business: {
      product: "app",
      version: QODER_COSY_VERSION,
      type: "agent",
      id: newQoderId(),
      name: "copilot-api session",
      begin_at: Date.now(),
      stage: "start",
    },
    agent_id: "agent_common",
    task_id: "common",
    session_type: "app",
    model_config: model.config,
    system: [sys],
    messages: [
      { role: "system", content: [sys] },
      ...qoderMessages(payload.messages),
    ],
  }
  if (payload.tool_choice !== "none" && tools.length > 0) {
    body.tools = qoderTools(tools)
  }
  return JSON.stringify(body)
}
