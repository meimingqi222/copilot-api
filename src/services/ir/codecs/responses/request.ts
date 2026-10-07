import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type {
  IRGenerationOptions,
  IRPart,
  IRTextPart,
  IRTool,
  IRToolChoice,
  IRTurn,
  IRWebSearchOptions,
  RequestIR,
} from "~/services/ir/types"
import { encodeChatTextFormat } from "~/services/ir/codecs/messages-chat/text-format"
import { createHash } from "node:crypto"
import { LocalPayloadUnsupportedError } from "~/lib/error"
import { readOpenAIServiceTier } from "~/lib/service-tier"
import { isResponsesServerTool } from "~/services/protocols/responses/types"

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as RecordValue)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function flatToolName(namespace: string, name: string): string {
  const flat = `${namespace}__${name}`
  if (flat.length <= 64) return flat
  const suffix = createHash("sha256")
    .update(`${namespace}\0${name}`)
    .digest("hex")
    .slice(0, 8)
  return `${flat.slice(0, 55)}_${suffix}`
}

function decodeContent(value: unknown): Array<IRPart> {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) return []
  const parts: Array<IRPart> = []
  for (const valuePart of value) {
    const part = record(valuePart)
    if (!part)
      throw new LocalPayloadUnsupportedError("Malformed Responses content part")
    if (
      (part.type === "input_text"
        || part.type === "output_text"
        || part.type === "text")
      && typeof part.text === "string"
    ) {
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "input_image") {
      const url = string(part.image_url)
      const fileId = string(part.file_id)
      if (url) {
        parts.push({
          type: "image",
          source: {
            type: "url",
            url,
            ...((
              part.detail === "auto"
              || part.detail === "low"
              || part.detail === "high"
            ) ?
              { detail: part.detail }
            : {}),
          },
        })
      } else if (fileId) {
        parts.push({ type: "file", source: { type: "file_id", fileId } })
      } else {
        throw new LocalPayloadUnsupportedError(
          "Responses input_image has no usable source",
        )
      }
    } else if (part.type === "input_file") {
      const fileId = string(part.file_id)
      const fileUrl = string(part.file_url)
      const fileData = string(part.file_data)
      if (fileId)
        parts.push({ type: "file", source: { type: "file_id", fileId } })
      else if (fileUrl)
        parts.push({ type: "file", source: { type: "url", url: fileUrl } })
      else if (fileData) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(fileData)
        if (!match)
          throw new LocalPayloadUnsupportedError(
            "Unsupported Responses input_file data encoding",
          )
        parts.push({
          type: "file",
          source: {
            type: "base64",
            mediaType: match[1] ?? "application/octet-stream",
            data: match[2] ?? "",
          },
        })
      } else
        throw new LocalPayloadUnsupportedError(
          "Responses input_file has no usable source",
        )
    } else {
      throw new LocalPayloadUnsupportedError(
        `Unsupported Responses content type: ${String(part.type)}`,
      )
    }
  }
  return parts
}

function decodeToolResultContent(
  value: unknown,
): Array<IRTextPart | Extract<IRPart, { type: "image" | "file" }>> {
  return decodeContent(value).filter(
    (part): part is IRTextPart | Extract<IRPart, { type: "image" | "file" }> =>
      part.type === "text" || part.type === "image" || part.type === "file",
  )
}

function decodeTools(value: unknown): Array<IRTool> {
  if (!Array.isArray(value)) return []
  const tools: Array<IRTool> = []
  const used = new Set<string>()
  const add = (tool: RecordValue, namespace?: string): void => {
    const originalName = string(tool.name)
    if (!originalName)
      throw new LocalPayloadUnsupportedError(
        "Responses function tool has no name",
      )
    const name =
      namespace ? flatToolName(namespace, originalName) : originalName
    if (used.has(name))
      throw new LocalPayloadUnsupportedError(
        `Responses tool name collision: ${name}`,
      )
    used.add(name)
    tools.push({
      name,
      description: string(tool.description),
      parameters: record(tool.parameters) ?? {},
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      ...(namespace ? { namespace, originalName } : {}),
    })
  }
  for (const valueTool of value) {
    const tool = record(valueTool)
    if (!tool)
      throw new LocalPayloadUnsupportedError("Malformed Responses tool")
    if (tool.type === "namespace") {
      const namespace = string(tool.name)
      if (!namespace || !Array.isArray(tool.tools))
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses namespace tool",
        )
      for (const nested of tool.tools) {
        const nestedTool = record(nested)
        if (!nestedTool || nestedTool.type !== "function")
          throw new LocalPayloadUnsupportedError(
            "Unsupported Responses namespace member",
          )
        add(nestedTool, namespace)
      }
    } else if (tool.type === "function") {
      add(tool)
    } else if (
      typeof tool.type !== "string"
      || !tool.type.startsWith("web_search")
    ) {
      throw new LocalPayloadUnsupportedError(
        `Unsupported Responses tool type: ${String(tool.type)}`,
      )
    }
  }
  return tools
}

function decodeToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required")
    return { type: value }
  const choice = record(value)
  if (!choice)
    throw new LocalPayloadUnsupportedError("Unsupported Responses tool_choice")
  if (choice.type === "function") {
    const name = string(choice.name)
    const namespace = string(choice.namespace)
    if (!name)
      throw new LocalPayloadUnsupportedError(
        "Responses function tool_choice has no name",
      )
    return {
      type: "tool",
      name: namespace ? flatToolName(namespace, name) : name,
    }
  }
  if (choice.type !== "allowed_tools")
    throw new LocalPayloadUnsupportedError(
      `Unsupported Responses tool_choice: ${String(choice.type)}`,
    )
  if (choice.mode !== "auto" && choice.mode !== "required") {
    throw new LocalPayloadUnsupportedError(
      "Invalid Responses allowed_tools mode",
    )
  }
  const allowed = new Set<string>()
  for (const raw of Array.isArray(choice.tools) ? choice.tools : []) {
    const item = record(raw)
    if (!item || item.type !== "function")
      throw new LocalPayloadUnsupportedError(
        "Unsupported Responses allowed_tools member",
      )
    const name = string(item.name)
    const namespace = string(item.namespace)
    if (!name)
      throw new LocalPayloadUnsupportedError(
        "Responses allowed_tools member has no name",
      )
    allowed.add(namespace ? flatToolName(namespace, name) : name)
  }
  // Unknown names remain visible to preflight, which rejects an invalid
  // restriction instead of silently widening or narrowing it.
  const names = [...allowed]
  if (choice.mode === "required" && names.length === 0) {
    throw new LocalPayloadUnsupportedError(
      "Responses required allowed_tools set is empty",
    )
  }
  return { type: "allowed", mode: choice.mode, names }
}

function decodeGeneration(payload: ResponsesPayload): IRGenerationOptions {
  const p = payload
  const generation: IRGenerationOptions = {}
  generation.serviceTier = readOpenAIServiceTier(p.service_tier)
  if (typeof p.max_output_tokens === "number")
    generation.maxOutputTokens = p.max_output_tokens
  if (typeof p.temperature === "number") generation.temperature = p.temperature
  if (typeof p.top_p === "number") generation.topP = p.top_p
  if (typeof p.max_tool_calls === "number")
    generation.maxToolCalls = p.max_tool_calls
  if (typeof p.parallel_tool_calls === "boolean")
    generation.parallelToolCalls = p.parallel_tool_calls
  if (typeof p.store === "boolean") generation.store = p.store
  if (typeof p.background === "boolean") generation.background = p.background
  if (typeof p.previous_response_id === "string")
    generation.previousResponseId = p.previous_response_id
  if (p.truncation) generation.truncation = p.truncation
  if (p.metadata) generation.metadata = p.metadata
  if (typeof p.user === "string") generation.user = p.user
  if (Array.isArray(p.tools)) {
    const searchTool = p.tools.find(isResponsesServerTool)
    if (searchTool) {
      generation.webSearch = true
      generation.webSearchOptions = {
        wireType: searchTool.type,
        ...(typeof searchTool.max_uses === "number" ?
          { maxUses: searchTool.max_uses }
        : {}),
        ...(Array.isArray(searchTool.allowed_domains) ?
          { allowedDomains: searchTool.allowed_domains }
        : {}),
      }
    }
  }
  if (p.text?.format) {
    if (p.text.format.type === "json_schema") {
      const { type: _type, ...jsonSchema } = p.text.format
      generation.textFormat = { type: "json_schema", jsonSchema }
    } else {
      generation.textFormat = { type: p.text.format.type }
    }
  }
  const reasoning = record(p.reasoning)
  if (typeof reasoning?.effort === "string") {
    const effort = reasoning.effort
    if (
      effort === "none"
      || effort === "low"
      || effort === "medium"
      || effort === "high"
    ) {
      generation.reasoning = {
        effort,
        ...((
          reasoning.summary === "auto"
          || reasoning.summary === "concise"
          || reasoning.summary === "detailed"
        ) ?
          { summary: reasoning.summary }
        : {}),
      }
    }
  }
  return generation
}

/** Decode Responses input without attributing a reasoning item past an intervening user/tool turn. */
export function decodeResponsesRequest(payload: ResponsesPayload): RequestIR {
  const source = { wire: "responses" as const, model: payload.model }
  const instructions: RequestIR["instructions"] =
    payload.instructions ?
      [
        {
          role: "system",
          parts: [{ type: "text", text: payload.instructions }],
          source,
        },
      ]
    : []
  const turns: Array<IRTurn> = []
  let pendingReasoning: Extract<IRPart, { type: "thinking" }> | undefined
  const takeReasoning = (): Array<IRPart> => {
    const part = pendingReasoning
    pendingReasoning = undefined
    return part ? [part] : []
  }
  const input =
    typeof payload.input === "string" ?
      [{ role: "user", content: payload.input }]
    : payload.input
  for (const valueItem of input) {
    const item = record(valueItem)
    if (!item)
      throw new LocalPayloadUnsupportedError("Malformed Responses input item")
    if (item.type === "reasoning") {
      const summary =
        Array.isArray(item.summary) ?
          item.summary.map((raw) => string(record(raw)?.text) ?? "").join("")
        : ""
      pendingReasoning =
        summary || string(item.encrypted_content) ?
          {
            type: "thinking",
            text: summary,
            source,
            ...(string(item.encrypted_content) ?
              { encryptedContent: string(item.encrypted_content) }
            : {}),
          }
        : undefined
      continue
    }
    if (item.type === "function_call") {
      const name = string(item.name)
      const callId = string(item.call_id)
      if (!name || !callId)
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses function_call",
        )
      if (name && callId) {
        const namespace = string(item.namespace)
        turns.push({
          role: "assistant",
          source,
          parts: [
            ...takeReasoning(),
            {
              type: "tool_call",
              id: callId,
              name: namespace ? flatToolName(namespace, name) : name,
              arguments: string(item.arguments) ?? "{}",
              ...(namespace ? { namespace, originalName: name } : {}),
            },
          ],
        })
      }
      continue
    }
    if (item.type === "function_call_output") {
      pendingReasoning = undefined
      const callId = string(item.call_id)
      if (
        !callId
        || (typeof item.output !== "string" && !Array.isArray(item.output))
      )
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses function_call_output",
        )
      if (callId)
        turns.push({
          role: "tool",
          source,
          parts: [
            {
              type: "tool_result",
              callId,
              content: decodeToolResultContent(item.output),
            },
          ],
        })
      continue
    }
    if (item.type === "web_search_call") {
      pendingReasoning = undefined
      const id = string(item.id) ?? string(item.call_id)
      if (id)
        turns.push({
          role: "assistant",
          source,
          parts: [
            {
              type: "server_tool_use",
              id,
              name: "web_search",
              input: JSON.stringify(item.action ?? {}),
            },
          ],
        })
      continue
    }
    if (item.role === "system" || item.role === "developer") {
      const parts = decodeContent(item.content)
      if (parts.some((part) => part.type !== "text"))
        throw new LocalPayloadUnsupportedError(
          "Responses instruction contains non-text content",
        )
      instructions.push({
        role: item.role,
        source,
        parts: parts as Array<IRTextPart>,
      })
      pendingReasoning = undefined
      continue
    }
    if (item.role === "user" || item.role === "assistant") {
      const isAssistant = item.role === "assistant"
      turns.push({
        role: item.role,
        source,
        parts: [
          ...(isAssistant ? takeReasoning() : []),
          ...decodeContent(item.content),
        ],
      })
      if (!isAssistant) pendingReasoning = undefined
      continue
    }
    throw new LocalPayloadUnsupportedError(
      `Unsupported Responses input item: ${String(item.type)}`,
    )
  }
  const tools = decodeTools(payload.tools)
  return {
    model: payload.model,
    source,
    instructions,
    turns,
    ...(tools.length ? { tools } : {}),
    ...(payload.tool_choice ?
      { toolChoice: decodeToolChoice(payload.tool_choice) }
    : {}),
    generation: decodeGeneration(payload),
  }
}

function encodeContent(parts: Array<IRPart>): Array<RecordValue> {
  const content: Array<RecordValue> = []
  for (const part of parts) {
    if (part.type === "text")
      content.push({ type: "input_text", text: part.text })
    else if (part.type === "image") {
      if (part.source.type === "url")
        content.push({
          type: "input_image",
          image_url: part.source.url,
          detail: part.source.detail,
        })
      else
        content.push({
          type: "input_image",
          image_url: `data:${part.source.mediaType};base64,${part.source.data}`,
        })
    } else if (part.type === "file") {
      if (part.source.type === "file_id")
        content.push({ type: "input_file", file_id: part.source.fileId })
      else if (part.source.type === "url")
        content.push({ type: "input_file", file_url: part.source.url })
      else
        content.push({
          type: "input_file",
          file_data: `data:${part.source.mediaType};base64,${part.source.data}`,
        })
    }
  }
  return content
}

function encodeTools(tools: Array<IRTool>): Array<RecordValue> {
  const result: Array<RecordValue> = []
  const namespaces = new Map<string, Array<RecordValue>>()
  for (const tool of tools) {
    const wire = {
      type: "function",
      name: tool.originalName ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    }
    if (tool.namespace) {
      const nested = namespaces.get(tool.namespace) ?? []
      nested.push(wire)
      namespaces.set(tool.namespace, nested)
    } else result.push(wire)
  }
  for (const [name, nested] of namespaces)
    result.push({ type: "namespace", name, tools: nested })
  return result
}

/**
 * Responses' own search tool spellings. Anthropic's `web_search_20250305` also
 * starts with `web_search`, so a prefix test would leak that version into the
 * Responses payload; only this wire's shapes are accepted.
 */
const RESPONSES_SEARCH_TOOL = /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/

function responsesSearchWireType(
  value: string | undefined,
): string | undefined {
  return value && RESPONSES_SEARCH_TOOL.test(value) ? value : undefined
}

/**
 * Declared tools plus a `web_search` declaration reconstructed from the search
 * intent. Returns `undefined` when there is nothing to declare, so the caller
 * can omit the field entirely.
 */
function encodeRequestTools(
  tools: Array<IRTool>,
  search: IRWebSearchOptions | undefined,
): Array<RecordValue> | undefined {
  if (!search && tools.length === 0) return undefined
  const wireType = responsesSearchWireType(search?.wireType)
  return [
    ...(search ?
      [
        {
          type: wireType ?? "web_search",
          ...(search.maxUses !== undefined && { max_uses: search.maxUses }),
          ...(search.allowedDomains && {
            allowed_domains: search.allowedDomains,
          }),
        },
      ]
    : []),
    ...encodeTools(tools),
  ]
}

function encodeToolChoice(
  choice: IRToolChoice | undefined,
  tools: Array<IRTool>,
): unknown {
  if (!choice) return undefined
  if (
    choice.type === "auto"
    || choice.type === "none"
    || choice.type === "required"
  )
    return choice.type
  if (choice.type === "tool") {
    const tool = tools.find((item) => item.name === choice.name)
    return {
      type: "function",
      name: tool?.originalName ?? choice.name,
      ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    }
  }
  if (choice.type !== "allowed") return undefined
  const allowed = choice.names.map((name) => {
    const tool = tools.find((item) => item.name === name)
    return {
      type: "function",
      name: tool?.originalName ?? name,
      ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    }
  })
  if (choice.mode === "required" && allowed.length === 0)
    throw new Error("Responses required allowed_tools set is empty")
  return { type: "allowed_tools", mode: choice.mode, tools: allowed }
}

/** Encode a request into Responses wire. Opaque replay material stays on its originating wire. */
export function encodeResponsesRequest(ir: RequestIR): ResponsesPayload {
  const items: Array<RecordValue> = []
  for (const turn of ir.turns) {
    if (turn.role === "tool") {
      for (const part of turn.parts) {
        if (part.type !== "tool_result") continue
        const output = encodeContent(part.content)
        items.push({
          type: "function_call_output",
          call_id: part.callId,
          output:
            output.length === 1 && output[0]?.type === "input_text" ?
              output[0].text
            : output,
        })
      }
      continue
    }
    const content = encodeContent(turn.parts)
    if (turn.role === "assistant") {
      for (const part of turn.parts) {
        if (part.type !== "thinking") continue
        // Responses accepts only its own replay objects as opaque reasoning.
        // Historical thinking from another wire remains readable assistant
        // context, without inventing encrypted_content for it.
        if (part.source.wire !== "responses" && part.text) {
          content.unshift({
            type: "input_text",
            text: `[historical reasoning] ${part.text}`,
          })
          continue
        }
        if (
          part.source.wire === "responses"
          && (part.text || part.encryptedContent)
        ) {
          items.push({
            type: "reasoning",
            summary:
              part.text ? [{ type: "summary_text", text: part.text }] : [],
            ...(part.encryptedContent ?
              { encrypted_content: part.encryptedContent }
            : {}),
          })
        }
      }
    }
    if (content.length) items.push({ role: turn.role, content })
    else if (turn.role === "user") items.push({ role: "user", content: "" })
    for (const part of turn.parts) {
      if (part.type !== "tool_call") continue
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.originalName ?? part.name,
        ...(part.namespace ? { namespace: part.namespace } : {}),
        arguments: part.arguments,
      })
    }
  }
  const generation = ir.generation
  const tools = ir.tools ?? []
  const encodedTools = encodeRequestTools(tools, generation?.webSearchOptions)
  const textFormat = encodeChatTextFormat(
    generation?.textFormat,
  ).response_format
  const payload: RecordValue = {
    model: ir.model,
    input: items,
    service_tier: readOpenAIServiceTier(generation?.serviceTier),
    ...(ir.instructions.length ?
      {
        instructions: ir.instructions
          .flatMap((instruction) => instruction.parts.map((part) => part.text))
          .join("\n\n"),
      }
    : {}),
    ...(encodedTools ? { tools: encodedTools } : {}),
    ...(ir.toolChoice ?
      { tool_choice: encodeToolChoice(ir.toolChoice, tools) }
    : {}),
    ...(generation?.maxOutputTokens !== undefined ?
      { max_output_tokens: generation.maxOutputTokens }
    : {}),
    ...(generation?.temperature !== undefined ?
      { temperature: generation.temperature }
    : {}),
    ...(generation?.topP !== undefined ? { top_p: generation.topP } : {}),
    ...(generation?.maxToolCalls !== undefined ?
      { max_tool_calls: generation.maxToolCalls }
    : {}),
    ...(generation?.parallelToolCalls !== undefined ?
      { parallel_tool_calls: generation.parallelToolCalls }
    : {}),
    ...(generation?.store !== undefined ? { store: generation.store } : {}),
    ...(generation?.background !== undefined ?
      { background: generation.background }
    : {}),
    ...(generation?.previousResponseId ?
      { previous_response_id: generation.previousResponseId }
    : {}),
    ...(generation?.truncation ? { truncation: generation.truncation } : {}),
    ...(generation?.metadata ? { metadata: generation.metadata } : {}),
    ...(generation?.user ? { user: generation.user } : {}),
    ...(textFormat ?
      {
        text: {
          format:
            textFormat.type === "json_schema" ?
              {
                type: "json_schema",
                ...textFormat.json_schema,
              }
            : { type: textFormat.type },
        },
      }
    : {}),
    ...((
      generation?.reasoning?.effort && generation.reasoning.effort !== "none"
    ) ?
      {
        reasoning: {
          effort: generation.reasoning.effort,
          summary: generation.reasoning.summary ?? "auto",
        },
      }
    : {}),
  }
  return payload as unknown as ResponsesPayload
}
