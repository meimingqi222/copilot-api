import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import { cleanJsonSchemaForAntigravityTool } from "~/lib/gemini-schema"
import {
  LEVEL_TO_BUDGET,
  extractReasoningPartsText,
  extractReasoningTextAlias,
  geminiSupportsLevelFormat,
} from "~/lib/thinking"

const FUNCTION_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

/**
 * Pre-resolved signature map: thinkingText → cached signature.
 * Populated by `preResolveSignatures` before translation.
 */
interface SignatureRegistry {
  get(text: string): string
}

function createSignatureRegistry(
  entries: Array<[string, string]>,
): SignatureRegistry {
  const map = new Map(entries)
  return {
    get(text: string): string {
      return map.get(text) ?? FUNCTION_THOUGHT_SIGNATURE
    },
  }
}

/**
 * Pre-resolves cached thoughtSignatures for all assistant thinking text in
 * the message history. Returns a registry that the synchronous translation
 * functions use to look up signatures.
 */
/**
 * Resolves an assistant turn's thinking text.
 *
 * Must stay the single definition: the signature registry is keyed by this
 * exact string, so `preResolveSignatures` and `buildAssistantContent` looking
 * it up differently would miss every cache entry. Note this path emits
 * `reasoning_content` (see `translate-response.ts`), so reading only
 * `reasoning_text` would drop the thought on every round trip of our own reply.
 */
function assistantReasoningText(message: Message): string {
  // Response *content* is deliberately excluded — the cache is keyed by
  // thinking text, and `messageText` covers the visible text separately.
  // An empty top-level alias counts as absent (see `extractReasoningTextAlias`)
  // and falls through to reasoning carried as content parts.
  const text =
    extractReasoningTextAlias(message)
    ?? extractReasoningPartsText(message.content)
  return text.trim() ? text : ""
}

export async function preResolveSignatures(
  modelName: string,
  messages: Array<Message>,
): Promise<SignatureRegistry> {
  const { getCachedSignature } = await import("~/lib/cache/signature-cache")
  const entries: Array<[string, string]> = []

  for (const message of messages) {
    if (message.role !== "assistant") continue
    const reasoningText = assistantReasoningText(message)
    if (!reasoningText) continue
    const sig = await getCachedSignature(modelName, reasoningText)
    if (sig) {
      entries.push([reasoningText, sig])
    }
  }

  return createSignatureRegistry(entries)
}

export interface AntigravityGeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: {
    mimeType?: string
    data?: string
  }
  functionCall?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
  functionResponse?: {
    id?: string
    name?: string
    response?: {
      result?: unknown
    }
  }
}

export interface AntigravityGeminiContent {
  role: "user" | "model"
  parts: Array<AntigravityGeminiPart>
}

export interface AntigravityUpstreamBody {
  project: string
  model: string
  userAgent?: string
  requestType?: string
  requestId?: string
  // 顶层 toolConfig 可能由其他翻译器产生，发送前需迁移到 request.toolConfig
  toolConfig?: unknown
  request: {
    sessionId?: string
    contents: Array<AntigravityGeminiContent>
    systemInstruction?: {
      role?: string
      parts: Array<{ text?: string }>
    }
    generationConfig?: Record<string, unknown>
    tools?: Array<Record<string, unknown>>
    toolConfig?: {
      functionCallingConfig: {
        mode: "NONE" | "AUTO" | "ANY"
        allowedFunctionNames?: Array<string>
      }
    }
    // safetySettings 可能由翻译层意外产生，发送前需删除
    safetySettings?: unknown
  }
}

function sanitizeFunctionName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    return "function"
  }
  return trimmed.replaceAll(/[^\w.-]/g, "_")
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  if (!url.startsWith("data:")) {
    return null
  }
  const pieces = url.slice(5).split(";")
  if (pieces.length < 2 || !pieces[1].startsWith("base64,")) {
    return null
  }
  return {
    mimeType: pieces[0] || "application/octet-stream",
    data: pieces[1].slice(7),
  }
}

function messageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  const parts: Array<string> = []
  for (const part of content) {
    if (part.type === "text" || part.type === "output_text") {
      parts.push(part.text)
    }
  }
  return parts.join("")
}

function buildUserParts(
  content: Message["content"],
  sigReg?: SignatureRegistry,
): Array<AntigravityGeminiPart> {
  if (typeof content === "string") {
    return content ? [{ text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }

  const parts: Array<AntigravityGeminiPart> = []
  for (const part of content) {
    if (part.type === "text" || part.type === "output_text") {
      if (part.text) {
        parts.push({ text: part.text })
      }
      continue
    }
    if (part.type === "image_url") {
      const inline = parseDataUrl(part.image_url.url)
      if (inline) {
        parts.push({
          inlineData: {
            mimeType: inline.mimeType,
            data: inline.data,
          },
          thoughtSignature:
            sigReg?.get(part.image_url.url) ?? FUNCTION_THOUGHT_SIGNATURE,
        })
      }
    }
  }
  return parts
}

function buildToolCallMap(messages: Array<Message>): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) {
      continue
    }
    for (const toolCall of message.tool_calls) {
      if (toolCall.id && toolCall.function.name) {
        map.set(toolCall.id, toolCall.function.name)
      }
    }
  }
  return map
}

function buildToolResponses(messages: Array<Message>): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) {
      continue
    }
    const content = messageText(message.content)
    map.set(message.tool_call_id, content || "{}")
  }
  return map
}

function parseFunctionArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return { params: trimmed }
  }
  return { params: trimmed }
}

function buildAssistantContent(
  message: Message,
  toolResponses: Map<string, string>,
  toolCallMap: Map<string, string>,
  sigReg?: SignatureRegistry,
): Array<AntigravityGeminiContent> {
  const contents: Array<AntigravityGeminiContent> = []
  const modelParts: Array<AntigravityGeminiPart> = []

  const text = messageText(message.content)
  if (text) {
    modelParts.push({ text })
  }

  const reasoningText = assistantReasoningText(message)

  // Include reasoning text as a thought part so Gemini can continue the
  // chain-of-thought. Attach the cached signature for replay validation.
  if (reasoningText) {
    modelParts.push({
      text: reasoningText,
      thought: true,
      thoughtSignature:
        sigReg ? sigReg.get(reasoningText) : FUNCTION_THOUGHT_SIGNATURE,
    })
  }

  // Use cached signature for tool calls (same signature as reasoning, since
  // Gemini associates the signature with the thinking that preceded the call).
  const reasoningSig =
    reasoningText && sigReg ?
      sigReg.get(reasoningText)
    : FUNCTION_THOUGHT_SIGNATURE

  const toolCallIds: Array<string> = []
  for (const [index, toolCall] of (message.tool_calls ?? []).entries()) {
    modelParts.push({
      functionCall: {
        id: toolCall.id,
        name: sanitizeFunctionName(toolCall.function.name),
        args: parseFunctionArgs(toolCall.function.arguments),
      },
      ...(index === 0 ? { thoughtSignature: reasoningSig } : {}),
    })
    toolCallIds.push(toolCall.id)
  }

  if (modelParts.length > 0) {
    contents.push({ role: "model", parts: modelParts })
  }

  const responseParts: Array<AntigravityGeminiPart> = []
  for (const toolCallId of toolCallIds) {
    const name = toolCallMap.get(toolCallId)
    if (!name) {
      continue
    }
    const raw = toolResponses.get(toolCallId) ?? "{}"
    let result: unknown
    try {
      result = JSON.parse(raw) as unknown
    } catch {
      result = raw
    }
    responseParts.push({
      functionResponse: {
        id: toolCallId,
        name: sanitizeFunctionName(name),
        response: { result },
      },
    })
  }
  if (responseParts.length > 0) {
    // Tool results are a *user* turn: CPA emits
    // `antigravityOpenAIContent("user", responseParts)`
    // (antigravity_openai_request.go), and its signature validator documents
    // the same rule ("user functionResponse/tool-result parts"). Emitting them
    // as "model" produces two consecutive model turns and the upstream can
    // silently ignore the tool output.
    contents.push({ role: "user", parts: responseParts })
  }

  return contents
}

// Gemini function declaration parameters 不支持完整 JSON Schema 规范，
// 需要完整清理。移植自 CPA 的 CleanJSONSchemaForAntigravityTool。

function buildTools(
  tools: Array<Tool> | null | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }
  const declarations = tools.map((tool) => ({
    name: sanitizeFunctionName(tool.function.name),
    description: tool.function.description,
    parameters: cleanJsonSchemaForAntigravityTool(
      tool.function.parameters,
      true,
    ),
  }))
  if (declarations.length === 0) {
    return undefined
  }
  return [{ functionDeclarations: declarations }]
}

/** String `tool_choice` values CPA maps to a functionCallingConfig mode. */
const TOOL_CHOICE_MODES = new Map<string, "NONE" | "AUTO" | "ANY">([
  ["none", "NONE"],
  ["auto", "AUTO"],
  ["required", "ANY"],
  ["any", "ANY"],
])

/**
 * Maps OpenAI `tool_choice` onto Gemini `toolConfig.functionCallingConfig`,
 * mirroring CPA `applyOpenAIToolChoiceToAntigravity`.
 *
 * The payload is an unvalidated cast of the client body (`readJsonBody<T>`),
 * so `tool_choice` can hold any JSON value. Anything that does not map to a
 * mode is dropped rather than coerced into a forced-function choice — the old
 * fall-through dereferenced `toolChoice.function.name` and threw on strings
 * outside the declared union (e.g. the `"any"` alias CPA accepts).
 */
function buildToolConfig(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): AntigravityUpstreamBody["request"]["toolConfig"] {
  if (toolChoice === null || toolChoice === undefined) return undefined

  if (typeof toolChoice === "string") {
    const mode = TOOL_CHOICE_MODES.get(toolChoice.trim().toLowerCase())
    return mode ? { functionCallingConfig: { mode } } : undefined
  }

  const choice = toolChoice as { type?: unknown; function?: { name?: unknown } }
  if (
    typeof choice.type !== "string"
    || choice.type.trim().toLowerCase() !== "function"
  ) {
    return undefined
  }

  const name = choice.function?.name
  // CPA only emits allowedFunctionNames for a non-empty name; a forced-function
  // choice missing a usable name degrades to plain ANY.
  if (typeof name !== "string" || !name.trim()) {
    return { functionCallingConfig: { mode: "ANY" } }
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [sanitizeFunctionName(name)],
    },
  }
}

/**
 * Builds the Gemini thinkingConfig from a reasoning_effort level.
 *
 * Gemini 2.x models only support `thinkingBudget` (numeric), while Gemini 3+
 * supports `thinkingLevel` (string). This function selects the correct format
 * based on the target model, matching CPA's Gemini applier behavior.
 */
function buildGeminiThinkingConfig(
  effort: string,
  model: string,
): Record<string, unknown> {
  const level = effort.toLowerCase()

  // auto → thinkingBudget=-1 (both Gemini 2.5 and 3 support this)
  if (level === "auto") {
    return { thinkingBudget: -1, includeThoughts: true }
  }

  // none → disable thinking
  if (level === "none") {
    return { thinkingBudget: 0, includeThoughts: false }
  }

  if (geminiSupportsLevelFormat(model)) {
    // Gemini 3+: use thinkingLevel string format
    return { thinkingLevel: level, includeThoughts: true }
  }

  // Gemini 2.x: convert level string to thinkingBudget numeric format
  if (level in LEVEL_TO_BUDGET) {
    return {
      thinkingBudget: LEVEL_TO_BUDGET[level],
      includeThoughts: LEVEL_TO_BUDGET[level] > 0,
    }
  }

  // Unknown level: use thinkingLevel as fallback (let upstream validate)
  return { thinkingLevel: level, includeThoughts: true }
}

export function translateOpenAiChatToAntigravity(
  payload: ChatCompletionsPayload,
  projectId: string,
  signatureRegistry?: SignatureRegistry,
): AntigravityUpstreamBody {
  const model = payload.model
  const messages = payload.messages
  const toolCallMap = buildToolCallMap(messages)
  const toolResponses = buildToolResponses(messages)
  const sigReg = signatureRegistry ?? createSignatureRegistry([])

  const body: AntigravityUpstreamBody = {
    project: projectId,
    model,
    request: {
      contents: [],
    },
  }

  const systemParts: Array<{ text?: string }> = []
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = messageText(message.content)
      if (text) {
        systemParts.push({ text })
      }
      continue
    }

    if (message.role === "user") {
      const parts = buildUserParts(message.content, sigReg)
      if (parts.length > 0) {
        body.request.contents.push({ role: "user", parts })
      }
      continue
    }

    if (message.role === "assistant") {
      body.request.contents.push(
        ...buildAssistantContent(message, toolResponses, toolCallMap, sigReg),
      )
    }
  }

  if (systemParts.length > 0) {
    body.request.systemInstruction = {
      role: "user",
      parts: systemParts,
    }
  }

  const generationConfig: Record<string, unknown> = {}
  if (payload.temperature !== null && payload.temperature !== undefined) {
    generationConfig.temperature = payload.temperature
  }
  if (payload.top_p !== null && payload.top_p !== undefined) {
    generationConfig.topP = payload.top_p
  }
  if (payload.max_tokens !== null && payload.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = payload.max_tokens
  }
  if (payload.reasoning_effort) {
    generationConfig.thinkingConfig = buildGeminiThinkingConfig(
      payload.reasoning_effort,
      payload.model,
    )
  }
  if (Object.keys(generationConfig).length > 0) {
    body.request.generationConfig = generationConfig
  }

  const tools = buildTools(payload.tools ?? undefined)
  if (tools) {
    body.request.tools = tools
  }
  const toolConfig = buildToolConfig(payload.tool_choice)
  if (toolConfig) {
    body.request.toolConfig = toolConfig
  }

  return body
}
