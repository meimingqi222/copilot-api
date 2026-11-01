import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type {
  DecodeLoss,
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
import { LocalPayloadUnsupportedError } from "~/lib/error"
import { readOpenAIServiceTier } from "~/lib/service-tier"
import { isResponsesServerTool } from "~/services/protocols/responses/types"
import {
  imagePartFromGenerationCall,
  responsesImageCall,
} from "~/services/ir/image-generation"

import { asRecord, asString } from "~/lib/json-shape"
import {
  customToolArguments,
  customToolDescription,
  customToolParameters,
} from "~/services/ir/codecs/responses/custom-tool"
import {
  type CodexInputState,
  decodeCodexInputItem,
  isLiteInput,
  LITE_NAMESPACE,
  TOOL_SEARCH_NAME,
} from "~/services/ir/codecs/responses/codex-input"
import { flatToolName } from "~/services/ir/codecs/responses/tool-names"

type RecordValue = Record<string, unknown>

function decodeContent(
  value: unknown,
  losses: Array<DecodeLoss>,
  path: string,
): Array<IRPart> {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) return []
  const parts: Array<IRPart> = []
  for (const [index, valuePart] of value.entries()) {
    const part = asRecord(valuePart)
    if (!part)
      throw new LocalPayloadUnsupportedError("Malformed Responses content part")
    if (
      (part.type === "input_text"
        || part.type === "output_text"
        || part.type === "text")
      && typeof part.text === "string"
    ) {
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      parts.push({ type: "text", text: part.refusal })
    } else if (part.type === "input_image") {
      const url = asString(part.image_url)
      const fileId = asString(part.file_id)
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
      const fileId = asString(part.file_id)
      const fileUrl = asString(part.file_url)
      const fileData = asString(part.file_data)
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
      if (
        ["input_text", "output_text", "text", "refusal"].includes(
          String(part.type),
        )
      )
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses text content",
        )
      losses.push({
        path: `${path}[${index}]`,
        feature: asString(part.type) ?? "unknown",
        action: "drop",
        reason: "content block has no equivalent on the target wire",
      })
    }
  }
  return parts
}

function decodeToolResultContent(
  value: unknown,
  losses: Array<DecodeLoss>,
  path: string,
): Array<IRTextPart | Extract<IRPart, { type: "image" | "file" }>> {
  return decodeContent(value, losses, path).filter(
    (part): part is IRTextPart | Extract<IRPart, { type: "image" | "file" }> =>
      part.type === "text" || part.type === "image" || part.type === "file",
  )
}

function irTool(tool: RecordValue, name: string): IRTool {
  if (tool.type === "custom")
    return {
      name,
      description: customToolDescription(tool),
      parameters: customToolParameters(),
      responsesType: "custom",
    }
  return {
    name,
    description: asString(tool.description),
    parameters: asRecord(tool.parameters) ?? {},
    ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    ...(tool.type === "tool_search" ? { responsesType: "tool_search" } : {}),
  }
}

/**
 * Decodes the tools a request offers: those it sent, then those its input
 * carries (`lifted`: Responses Lite's additional_tools, what a tool search
 * found), which Codex does not send again. A lifted tool already offered is
 * offered once. Hosted tools a translated target cannot run are dropped with
 * a loss record, as is a server-run tool search.
 */
function decodeTools(
  sent: unknown,
  lifted: Array<RecordValue>,
  losses: Array<DecodeLoss>,
): Array<IRTool> {
  const tools: Array<IRTool> = []
  const used = new Set<string>()
  const add = (tool: RecordValue, liftedTool: boolean, namespace?: string) => {
    const originalName = asString(tool.name)
    if (!originalName)
      throw new LocalPayloadUnsupportedError(
        "Responses function tool has no name",
      )
    const name =
      namespace ? flatToolName(namespace, originalName) : originalName
    if (used.has(name)) {
      if (liftedTool) return
      throw new LocalPayloadUnsupportedError(
        `Responses tool name collision: ${name}`,
      )
    }
    used.add(name)
    tools.push({
      ...irTool(tool, name),
      ...(namespace ? { namespace, originalName } : {}),
    })
  }
  const dropHosted = (type: string, path: string): void => {
    losses.push({
      path,
      feature: `${type}_tool`,
      action: "drop",
      reason: "hosted tool cannot be offered to a translated target",
    })
  }
  const all = [
    ...(Array.isArray(sent) ? sent : []).map((tool) => ({
      tool,
      liftedTool: false,
    })),
    ...lifted.map((tool) => ({ tool, liftedTool: true })),
  ]
  all.forEach(({ tool: valueTool, liftedTool }, index) => {
    const tool = asRecord(valueTool)
    if (!tool)
      throw new LocalPayloadUnsupportedError("Malformed Responses tool")
    const type = asString(tool.type) ?? ""
    const path = `tools[${index}]`
    if (type === "namespace") {
      const namespace = asString(tool.name)
      if (!namespace || !Array.isArray(tool.tools))
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses namespace tool",
        )
      tool.tools.forEach((nested: unknown, nestedIndex) => {
        const nestedTool = asRecord(nested)
        if (!nestedTool)
          throw new LocalPayloadUnsupportedError(
            "Malformed Responses namespace member",
          )
        if (nestedTool.type === "function" || nestedTool.type === "custom")
          add(nestedTool, liftedTool, namespace)
        else
          dropHosted(
            asString(nestedTool.type) ?? "unknown",
            `${path}.tools[${nestedIndex}]`,
          )
      })
    } else if (type === "function" || type === "custom") {
      add(tool, liftedTool)
    } else if (type === TOOL_SEARCH_NAME && tool.execution === "client") {
      // Codex runs its tool search itself: offered as the function it is.
      add({ ...tool, name: TOOL_SEARCH_NAME }, liftedTool)
    } else if (!type.startsWith("web_search")) {
      // Search intent is read from the tools by decodeGeneration.
      dropHosted(type || "unknown", path)
    }
  })
  return tools
}

function decodeToolChoice(
  value: unknown,
  lite: boolean,
): IRToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required")
    return { type: value }
  const choice = asRecord(value)
  if (!choice)
    throw new LocalPayloadUnsupportedError("Unsupported Responses tool_choice")
  if (choice.type === TOOL_SEARCH_NAME)
    return { type: "tool", name: TOOL_SEARCH_NAME }
  const toolName = (name: string, namespace: string | undefined) =>
    namespace && !(lite && namespace === LITE_NAMESPACE) ?
      flatToolName(namespace, name)
    : name
  if (choice.type === "function" || choice.type === "custom") {
    const name = asString(choice.name)
    const namespace = asString(choice.namespace)
    if (!name)
      throw new LocalPayloadUnsupportedError(
        "Responses function tool_choice has no name",
      )
    return {
      type: "tool",
      name: toolName(name, namespace),
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
    const item = asRecord(raw)
    if (
      !item
      || !["function", "custom", TOOL_SEARCH_NAME].includes(String(item.type))
    )
      throw new LocalPayloadUnsupportedError(
        "Unsupported Responses allowed_tools member",
      )
    const name =
      item.type === TOOL_SEARCH_NAME ? TOOL_SEARCH_NAME : asString(item.name)
    const namespace = asString(item.namespace)
    if (!name)
      throw new LocalPayloadUnsupportedError(
        "Responses allowed_tools member has no name",
      )
    allowed.add(toolName(name, namespace))
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
  const reasoning = asRecord(p.reasoning)
  const effort = responsesEffort(reasoning?.effort)
  if (effort && reasoning) {
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
  const losses: Array<DecodeLoss> = []
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
  const codex: CodexInputState = {
    source,
    turns,
    takeReasoning,
    clearReasoning: () => {
      pendingReasoning = undefined
    },
    decodeContent: (value, path) => decodeContent(value, losses, path),
    liftedTools: [],
    losses,
  }
  // Lite groups Codex's own tools in the `functions` namespace, which Codex
  // reads as no namespace; they are offered plain (codex-input.ts), so a
  // call to one is the plain call it now is.
  const lite = isLiteInput(input)
  const callNamespace = (item: RecordValue): string | undefined => {
    const namespace = asString(item.namespace)
    return lite && namespace === LITE_NAMESPACE ? undefined : namespace
  }
  for (const [index, valueItem] of input.entries()) {
    const item = asRecord(valueItem)
    if (!item)
      throw new LocalPayloadUnsupportedError("Malformed Responses input item")
    if (item.type === "image_generation_call") {
      const image = imagePartFromGenerationCall(item)
      if (!image)
        throw new LocalPayloadUnsupportedError(
          "Responses image_generation_call has no image result",
        )
      turns.push({
        role: "assistant",
        source,
        parts: [...takeReasoning(), image],
      })
      continue
    }
    if (item.type === "reasoning") {
      // The summary, else the reasoning itself when the item carries it.
      const summary =
        joinedText(item.summary) || joinedText(item.content, "reasoning_text")
      pendingReasoning =
        summary || asString(item.encrypted_content) ?
          {
            type: "thinking",
            text: summary,
            source,
            ...(asString(item.encrypted_content) ?
              { encryptedContent: asString(item.encrypted_content) }
            : {}),
          }
        : undefined
      continue
    }
    if (item.type === "function_call") {
      const name = asString(item.name)
      const callId = asString(item.call_id)
      if (!name || !callId)
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses function_call",
        )
      if (name && callId) {
        const namespace = callNamespace(item)
        turns.push({
          role: "assistant",
          source,
          parts: [
            ...takeReasoning(),
            {
              type: "tool_call",
              id: callId,
              name: namespace ? flatToolName(namespace, name) : name,
              arguments: asString(item.arguments) ?? "{}",
              ...(namespace ? { namespace, originalName: name } : {}),
            },
          ],
        })
      }
      continue
    }
    if (item.type === "custom_tool_call") {
      const name = asString(item.name)
      const callId = asString(item.call_id)
      if (!name || !callId || typeof item.input !== "string")
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses custom_tool_call",
        )
      const namespace = callNamespace(item)
      turns.push({
        role: "assistant",
        source,
        parts: [
          ...takeReasoning(),
          {
            type: "tool_call",
            id: callId,
            name: namespace ? flatToolName(namespace, name) : name,
            arguments: customToolArguments(item.input),
            responsesType: "custom",
            ...(namespace ? { namespace, originalName: name } : {}),
          },
        ],
      })
      continue
    }
    if (
      item.type === "function_call_output"
      || item.type === "custom_tool_call_output"
    ) {
      pendingReasoning = undefined
      const callId = asString(item.call_id)
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
              content: decodeToolResultContent(
                item.output,
                losses,
                `input[${index}].output`,
              ),
            },
          ],
        })
      continue
    }
    if (item.type === "web_search_call") {
      pendingReasoning = undefined
      const id = asString(item.id) ?? asString(item.call_id)
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
    const message = item.type === undefined || item.type === "message"
    if (message && (item.role === "system" || item.role === "developer")) {
      const parts = decodeContent(
        item.content,
        losses,
        `input[${index}].content`,
      )
      if (parts.some((part) => part.type !== "text"))
        throw new LocalPayloadUnsupportedError(
          "Responses instruction contains non-text content",
        )
      pendingReasoning = undefined
      if (turns.length > 0) {
        // Codex adds a developer message where its context changed (world
        // state, settings, a model switch) and keeps it there. Lifted into
        // the instructions it would change the prompt's very start, and every
        // later request would rewrite the whole conversation to the vendor's
        // prompt cache; it stays in place, told as the system's words.
        const text = (parts as Array<IRTextPart>)
          .map((part) => part.text)
          .join("\n")
        if (text)
          turns.push({
            role: "user",
            source,
            parts: [
              {
                type: "text",
                text: `<system-reminder>\n${text}\n</system-reminder>`,
              },
            ],
          })
        codex.losses.push({
          path: `input[${index}]`,
          feature: `${item.role}_message`,
          action: "transform",
          reason:
            "mid-conversation instruction kept in place as a user reminder",
        })
        continue
      }
      instructions.push({
        role: item.role,
        source,
        parts: parts as Array<IRTextPart>,
      })
      continue
    }
    if (message && (item.role === "user" || item.role === "assistant")) {
      const isAssistant = item.role === "assistant"
      turns.push({
        role: item.role,
        source,
        parts: [
          ...(isAssistant ? takeReasoning() : []),
          ...decodeContent(item.content, losses, `input[${index}].content`),
        ],
      })
      if (!isAssistant) pendingReasoning = undefined
      continue
    }
    if (decodeCodexInputItem(item, `input[${index}]`, codex)) continue
    throw new LocalPayloadUnsupportedError(
      `Unsupported Responses input item: ${String(item.type)}`,
    )
  }
  const tools = decodeTools(payload.tools, codex.liftedTools, codex.losses)
  const generation = decodeGeneration(payload)
  const toolChoice =
    payload.tool_choice ?
      decodeToolChoice(payload.tool_choice, lite)
    : undefined
  assertHostedToolChoice(losses, tools, toolChoice, generation)
  const effort = responsesEffort(codex.effort)
  if (effort) generation.reasoning = { ...generation.reasoning, effort }
  return {
    model: payload.model,
    source,
    instructions,
    turns,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    generation,
    ...(codex.losses.length ? { decodeLosses: codex.losses } : {}),
  }
}

/** Dropping a hosted declaration must not weaken an explicit execution contract. */
function assertHostedToolChoice(
  losses: Array<DecodeLoss>,
  tools: Array<IRTool>,
  toolChoice: IRToolChoice | undefined,
  generation: IRGenerationOptions,
): void {
  if (
    losses.some(
      (loss) =>
        loss.reason === "hosted tool cannot be offered to a translated target",
    )
    && ((toolChoice?.type === "required"
      && tools.length === 0
      && !generation.webSearch)
      || (toolChoice?.type === "tool"
        && !tools.some((tool) => tool.name === toolChoice.name)))
  )
    throw new LocalPayloadUnsupportedError(
      "Required Responses hosted tool cannot be offered to a translated target",
    )
}

/** A Responses reasoning effort the IR carries. */
function responsesEffort(
  value: unknown,
): NonNullable<IRGenerationOptions["reasoning"]>["effort"] {
  return (
      value === "none"
        || value === "minimal"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "xhigh"
        || value === "max"
        || value === "auto"
    ) ?
      value
    : undefined
}

/** Concatenated `text` of the parts in `value`, optionally of one type only. */
function joinedText(value: unknown, type?: string): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((raw) => {
      const part = asRecord(raw)
      return !type || part?.type === type ? (asString(part?.text) ?? "") : ""
    })
    .join("")
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

/** Messages puts tool results inside user turns; Responses needs separate items. */
function* splitToolResultTurns(turns: Array<IRTurn>): Iterable<IRTurn> {
  for (const turn of turns) {
    if (
      turn.role !== "user"
      || !turn.parts.some((part) => part.type === "tool_result")
    ) {
      yield turn
      continue
    }
    let parts: Array<IRPart> = []
    for (const part of turn.parts) {
      if (part.type !== "tool_result") {
        parts.push(part)
        continue
      }
      if (parts.length) yield { ...turn, parts }
      parts = []
      yield { ...turn, role: "tool", parts: [part] }
    }
    if (parts.length) yield { ...turn, parts }
  }
}

/** Opaque replay material stays on its originating wire. */
function encodeResponsesTurns(turns: Array<IRTurn>): Array<RecordValue> {
  const items: Array<RecordValue> = []
  for (const turn of splitToolResultTurns(turns)) {
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
    const replayImages =
      turn.role === "assistant" && turn.source?.wire === "responses"
    const content = encodeContent(
      turn.parts.filter(
        (part) => !(replayImages && part.type === "image" && part.id),
      ),
    )
    if (turn.role === "assistant") {
      for (const part of turn.parts) {
        if (replayImages && part.type === "image" && part.id) {
          items.push(responsesImageCall(part, part.id))
          continue
        }
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
  return items
}

/** Encode conversation history and generation options into Responses wire. */
export function encodeResponsesRequest(ir: RequestIR): ResponsesPayload {
  const generation = ir.generation
  const tools = ir.tools ?? []
  const encodedTools = encodeRequestTools(
    tools,
    generation?.webSearch === false ? undefined
    : generation?.webSearch ? (generation.webSearchOptions ?? {})
    : generation?.webSearchOptions,
  )
  const textFormat = encodeChatTextFormat(
    generation?.textFormat,
  ).response_format
  const payload: RecordValue = {
    model: ir.model,
    input: encodeResponsesTurns(ir.turns),
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
