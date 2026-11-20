import { LocalPayloadUnsupportedError } from "~/lib/error"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { record } from "~/services/wps-lingxi/client"

const MAX_BODY_BYTES = 320 * 1024

// Lingxi accepts one type per schema and cannot read union or reference keywords.
function simplifySchema(
  value: unknown,
  root = record(value),
  depth = 0,
  budget = { nodes: 10_000 },
): Record<string, unknown> {
  if (--budget.nodes <= 0)
    throw new LocalPayloadUnsupportedError(
      "WPS Lingxi tool schema expands past its complexity limit",
    )
  if (depth > 24) return { type: "string" }
  const input = record(value)
  const next = (schema: unknown) =>
    simplifySchema(schema, root, depth + 1, budget)
  const out: Record<string, unknown> = {}
  if (typeof input.$ref === "string" && input.$ref.startsWith("#/")) {
    let target: unknown = root
    for (const part of input.$ref.slice(2).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~")
      const parent = record(target)
      target = Object.hasOwn(parent, key) ? parent[key] : undefined
    }
    if (target && target !== value) Object.assign(out, next(target))
  }
  if (Array.isArray(input.allOf))
    for (const branch of input.allOf) Object.assign(out, next(branch))
  const union = [input.anyOf, input.oneOf].flatMap((branches) =>
    Array.isArray(branches) ? branches : [],
  )
  if (union.length) {
    const kept = union
      .filter((branch) => record(branch).type !== "null")
      .map(next)
    Object.assign(
      out,
      kept.find((branch) => branch.type === "object")
        ?? kept.find((branch) => branch.type === "array")
        ?? kept[0],
    )
  }
  return schemaFields(input, out, next)
}

function schemaFields(
  input: Record<string, unknown>,
  out: Record<string, unknown>,
  next: (schema: unknown) => Record<string, unknown>,
): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(input).flatMap(([key, val]) => {
      if (
        [
          "$ref",
          "$defs",
          "definitions",
          "not",
          "allOf",
          "anyOf",
          "oneOf",
        ].includes(key)
      )
        return []
      if (key === "const") return [["enum", [val]]]
      if (key === "properties" || key === "patternProperties") {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(record(val)).map(([name, schema]) => [
                name,
                next(schema),
              ]),
            ),
          ],
        ]
      }
      if (
        (key === "items" || key === "additionalProperties")
        && val
        && typeof val === "object"
      )
        return [[key, next(val)]]
      return [[key, val]]
    }),
  )
  const result = { ...out, ...fields }
  const type =
    Array.isArray(result.type) ?
      result.type.find((item) => typeof item === "string" && item !== "null")
    : result.type
  if (typeof type === "string" && type !== "null") return { ...result, type }
  const sample = Array.isArray(result.enum) ? result.enum[0] : undefined
  return {
    ...result,
    type:
      result.properties || result.required || result.additionalProperties ?
        "object"
      : result.items ? "array"
      : typeof sample === "number" || typeof sample === "boolean" ?
        typeof sample
      : "string",
  }
}

function fitBody(
  body: Record<string, unknown>,
  messages: ChatCompletionsPayload["messages"],
): void {
  let bytes = Buffer.byteLength(JSON.stringify(body))
  if (bytes <= MAX_BODY_BYTES) return
  // Keep system/developer instructions and the newest user turn, inclusive of
  // any assistant tool calls and their results. Never cut serialized tool args.
  const latestUser = messages.findLastIndex(
    (message) => message.role === "user",
  )
  const instructions = []
  const marker = {
    role: "system",
    content:
      "[Earlier conversation turns omitted due to the WPS Lingxi request limit.]",
  }
  bytes += Buffer.byteLength(JSON.stringify(marker)) + 1
  for (let i = 0; i <= latestUser; i++) {
    const message = messages[i]
    if (message.role === "system" || message.role === "developer") {
      instructions.push(message)
    } else {
      if (bytes <= MAX_BODY_BYTES && message.role === "user") {
        body.messages = [...instructions, marker, ...messages.slice(i)]
        return
      }
      bytes -= Buffer.byteLength(JSON.stringify(message)) + 1
    }
  }
  throw new LocalPayloadUnsupportedError(
    "WPS Lingxi cannot fit the current turn and instructions within its request limit",
  )
}

export function buildLingxiRequest(
  payload: ChatCompletionsPayload,
  model: string,
): Record<string, unknown> {
  if (payload.response_format && payload.response_format.type !== "text")
    throw new LocalPayloadUnsupportedError(
      "WPS Lingxi does not support structured response formats",
    )
  if ((payload.n ?? 1) !== 1)
    throw new LocalPayloadUnsupportedError(
      "WPS Lingxi supports one completion per request",
    )
  const tools = (payload.tools ?? [])
    .filter((tool) => tool.type === "function" && tool.function?.name?.trim())
    .map(({ function: fn }) => ({
      type: "function",
      function: {
        ...fn,
        parameters: simplifySchema({ type: "object", ...fn.parameters }),
      },
    }))
  const choice = payload.tool_choice
  if (
    (choice === "required" && !tools.length)
    || (choice
      && typeof choice === "object"
      && !tools.some((tool) => tool.function.name === choice.function.name))
  ) {
    throw new LocalPayloadUnsupportedError(
      "WPS Lingxi cannot honor the requested tool choice",
    )
  }
  const parallel = record(payload).parallel_tool_calls
  const max = payload.max_completion_tokens ?? payload.max_tokens
  const effort = payload.reasoning_effort?.trim()
  const body = {
    stream: true,
    model,
    messages: payload.messages,
    ...(tools.length && { tools, tool_choice: choice ?? undefined }),
    ...(typeof parallel === "boolean" && { parallel_tool_calls: parallel }),
    ...(typeof payload.temperature === "number" && {
      temperature: payload.temperature,
    }),
    ...(typeof max === "number"
      && Number.isInteger(max)
      && max > 0 && { base_llm_arguments: { max_tokens: max } }),
    ...(effort && {
      reasoning_effort: effort,
      llm_arguments: { reasoning_effort: effort },
    }),
  }
  fitBody(body, payload.messages)
  return body
}
