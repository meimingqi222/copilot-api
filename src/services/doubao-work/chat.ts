import { randomUUID } from "node:crypto"

import { asNumber, asRecord, asStringFieldOrEmpty } from "~/lib/json-shape"
import type { WorkReply } from "~/services/doubao-work/bridge"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  Message,
  ToolCall,
} from "~/services/protocols/chat/types"

const open = "<tool_call>"
const close = "</tool_call>"

function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content
  return (content ?? [])
    .map((part) => {
      if (part.type === "text" || part.type === "output_text") return part.text
      if (part.type === "image_url") return "[image omitted: text only]"
      // Additional compatible input content types may arrive at runtime.
      if (/^(?:input_)?file$/.test(part.type))
        return "[file omitted: text only]"
      return ""
    })
    .join("")
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function workPrompt(body: ChatCompletionsPayload): {
  text: string
  toolNames: ReadonlySet<string>
} {
  const only =
    typeof body.tool_choice === "object" ?
      body.tool_choice?.function.name
    : undefined
  const tools =
    body.tool_choice === "none" ?
      []
    : (body.tools ?? []).filter((tool) => !only || tool.function.name === only)
  const toolNames = new Set(tools.map((tool) => tool.function.name))
  const sections = [
    "You are the language model behind a client application. Do not run actions or use your own tools, web search, files, or computer. Reply only in text.",
  ]
  if (tools.length) {
    sections.push(
      `The client runs tools. When you need one, reply with one or more ${open}{"name":"<tool>","arguments":{}}${close} blocks, with nothing after them. Otherwise write plain text.`,
    )
    if (only) sections.push(`Call ${only} now.`)
    else if (body.tool_choice === "required")
      sections.push("Call at least one tool now.")
    sections.push(
      "# Tools\n\n"
        + tools
          .map(
            ({ function: fn }) =>
              `## ${fn.name}\n${fn.description ?? ""}\nArguments (JSON Schema): ${JSON.stringify(fn.parameters ?? {})}`,
          )
          .join("\n"),
    )
  }
  if (
    body.response_format?.type === "json_object"
    || body.response_format?.type === "json_schema"
  ) {
    sections.push(
      "Answer with one JSON value and nothing else."
        + (body.response_format.type === "json_schema" ?
          ` It must match this JSON Schema: ${JSON.stringify(body.response_format.json_schema.schema)}`
        : ""),
    )
  }
  const names = new Map<string, string>()
  for (const message of body.messages) {
    let text = messageText(message.content)
    for (const call of message.tool_calls ?? []) {
      names.set(call.id, call.function.name)
      const json = JSON.stringify({
        name: call.function.name,
        arguments:
          parseJson(call.function.arguments) ?? call.function.arguments,
      })
      text += `\n${open}${json}${close}`
    }
    const name =
      message.role === "tool" ?
        (message.name ?? names.get(message.tool_call_id ?? ""))
      : undefined
    sections.push(
      `[${message.role}${name ? ` result of ${name}` : ""}]\n${text}`,
    )
  }
  sections.push("Write the next [assistant] turn without the label.")
  return { text: sections.join("\n\n").replace(/\r\n?/g, "\n"), toolNames }
}

function toolCall(
  value: unknown,
  names: ReadonlySet<string>,
): ToolCall | undefined {
  const row = asRecord(value)
  const fn = asRecord(row?.function) ?? row
  const name =
    asStringFieldOrEmpty(fn, "name") || asStringFieldOrEmpty(row, "tool")
  if (!names.has(name)) return undefined
  const raw = fn?.arguments ?? fn?.parameters ?? fn?.input ?? fn?.args ?? {}
  const args = asRecord(typeof raw === "string" ? parseJson(raw) : raw)
  if (!args) return undefined
  return {
    id: `call_${randomUUID()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** End of a standalone JSON object, ignoring quotes and escaped braces. */
function objectEnd(text: string, at: number): number {
  let depth = 0
  let quoted = false
  for (let i = at; i < text.length; i++) {
    const char = text[i]
    if (quoted && char === "\\") i++
    else if (char === '"') quoted = !quoted
    else if (!quoted) {
      if (char === "{") depth++
      else if (char === "}" && --depth === 0) return i + 1
    }
  }
  return -1
}

const bareCalls = /^\s*\{\s*"tool_calls"\s*:/gm
const insideFence = (text: string, at: number) =>
  (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1

function liftBareCalls(
  text: string,
  names: ReadonlySet<string>,
): { text: string; calls: Array<ToolCall> } {
  const calls: Array<ToolCall> = []
  let rest = text
  for (const match of [...text.matchAll(bareCalls)].reverse()) {
    if (insideFence(text, match.index)) continue
    const start = text.indexOf("{", match.index)
    const end = objectEnd(text, start)
    if (end < 0) continue
    const list = asRecord(parseJson(text.slice(start, end)))?.tool_calls
    if (!Array.isArray(list) || !list.length) continue
    const parsed = list.map((item: unknown) => toolCall(item, names))
    if (!parsed.every((item) => item !== undefined)) continue
    calls.unshift(...parsed)
    rest = rest.slice(0, start) + rest.slice(end)
  }
  return { text: rest, calls }
}

export function workOutput(
  text: string,
  names: ReadonlySet<string>,
): { text: string; calls: Array<ToolCall> } {
  if (!names.size) return { text, calls: [] }
  const tagged: Array<ToolCall> = []
  const rest = text.replace(
    /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g,
    (whole, inner: string) => {
      const parsed = parseJson(
        inner.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""),
      )
      const call = toolCall(Array.isArray(parsed) ? parsed[0] : parsed, names)
      if (!call) return whole
      tagged.push(call)
      return ""
    },
  )
  const bare = liftBareCalls(rest, names)
  const calls = [...tagged, ...bare.calls]
  return {
    text: calls.length ? bare.text.replace(/```[a-z]*\s*```/gi, "") : text,
    calls,
  }
}

function safePrefix(text: string): string {
  const from = [
    text.indexOf(open),
    text.indexOf("```"),
    text.search(bareCalls),
  ].filter((index) => index >= 0)
  if (from.length) return text.slice(0, Math.min(...from))
  const line = text.slice(text.lastIndexOf("\n") + 1)
  const compact = line.replace(/\s/g, "")
  if (compact && '{"tool_calls":'.startsWith(compact))
    return text.slice(0, text.length - line.length)
  for (let n = Math.min(open.length - 1, text.length); n > 0; n--) {
    const suffix = text.slice(-n)
    if (open.startsWith(suffix) || "```".startsWith(suffix))
      return text.slice(0, -n)
  }
  return text
}

function usage(
  reply: WorkReply,
  prompt: string,
): NonNullable<ChatCompletionResponse["usage"]> {
  const raw = asRecord(
    typeof reply.usage === "string" ? parseJson(reply.usage) : reply.usage,
  )
  const fields = ["system_prompt", "messages", "skills", "tools"].map((key) =>
    asNumber(raw?.[key]),
  )
  const promptTokens =
    fields.some((field) => field !== undefined) ?
      fields.reduce<number>((sum, value) => sum + Math.max(0, value ?? 0), 0)
    : Math.ceil(prompt.length / 3)
  const completion = Math.ceil((reply.text.length + reply.reasoning.length) / 3)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
  }
}

export function chatResult(
  model: string,
  prompt: ReturnType<typeof workPrompt>,
  reply: WorkReply,
): ChatCompletionResponse {
  const { text, calls } = workOutput(reply.text, prompt.toolNames)
  return {
    id: `chatcmpl-${randomUUID()}`,
    model,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content: text || (calls.length ? null : ""),
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: usage(reply, prompt.text),
  }
}

export async function streamChat(
  model: string,
  prompt: ReturnType<typeof workPrompt>,
  ask: (
    update: (reply: WorkReply) => void,
    signal: AbortSignal,
  ) => Promise<WorkReply>,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent>> {
  const abort = new AbortController()
  const both = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const first = Promise.withResolvers<void>()
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let begun = false
  let shown = ""
  let thought = ""
  const output = new ReadableStream<CopilotStreamEvent>({
    start(controller) {
      const push = (
        choices: ChatCompletionChunk["choices"],
        metering?: ChatCompletionChunk["usage"],
      ) =>
        controller.enqueue({
          data: JSON.stringify({
            id,
            model,
            created,
            object: "chat.completion.chunk",
            choices,
            usage: metering,
          }),
        })
      const delta = (
        value: ChatCompletionChunk["choices"][number]["delta"],
        finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
      ) =>
        push([
          { index: 0, delta: value, finish_reason: finish, logprobs: null },
        ])
      const begin = () => {
        if (begun) return
        begun = true
        delta({ role: "assistant", content: "" })
        first.resolve()
      }
      const update = (reply: WorkReply) => {
        if (both.aborted) return
        begin()
        if (
          reply.reasoning.startsWith(thought)
          && reply.reasoning.length > thought.length
        ) {
          delta({ reasoning_content: reply.reasoning.slice(thought.length) })
          thought = reply.reasoning
        }
        const prefix =
          prompt.toolNames.size ? safePrefix(reply.text) : reply.text
        if (prefix.startsWith(shown) && prefix.length > shown.length) {
          delta({ content: prefix.slice(shown.length) })
          shown = prefix
        }
      }
      void ask(update, both)
        .then((reply) => {
          both.throwIfAborted()
          update(reply)
          const { text, calls } = workOutput(reply.text, prompt.toolNames)
          if (!text.startsWith(shown) || !reply.reasoning.startsWith(thought)) {
            throw new Error("Doubao Work rewrote already streamed text.")
          }
          if (text.length > shown.length)
            delta({ content: text.slice(shown.length) })
          if (calls.length)
            delta({
              tool_calls: calls.map((call, index) => ({ index, ...call })),
            })
          delta({}, calls.length ? "tool_calls" : "stop")
          push([], usage(reply, prompt.text))
          controller.enqueue({ data: "[DONE]" })
          controller.close()
        })
        .catch((error: unknown) => {
          if (!begun) first.reject(error)
          if (!abort.signal.aborted) controller.error(error)
        })
    },
    cancel() {
      abort.abort()
    },
  })
  await first.promise
  return output
}
