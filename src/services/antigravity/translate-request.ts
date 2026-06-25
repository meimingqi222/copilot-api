import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

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
export async function preResolveSignatures(
  modelName: string,
  messages: Array<Message>,
): Promise<SignatureRegistry> {
  const { getCachedSignature } = await import("~/lib/cache/signature-cache")
  const entries: Array<[string, string]> = []

  for (const message of messages) {
    if (message.role !== "assistant") continue
    // Only use reasoning_text for signature lookup — the signature cache is
    // keyed by thinking text, not response content.
    const reasoningText = message.reasoning_text
    if (typeof reasoningText === "string" && reasoningText.trim()) {
      const sig = await getCachedSignature(modelName, reasoningText)
      if (sig) {
        entries.push([reasoningText, sig])
      }
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
  request: {
    contents: Array<AntigravityGeminiContent>
    systemInstruction?: {
      role?: string
      parts: Array<{ text?: string }>
    }
    generationConfig?: Record<string, unknown>
    tools?: Array<Record<string, unknown>>
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

  // Use cached signature for reasoning text if available
  const reasoningSig =
    message.reasoning_text && sigReg ?
      sigReg.get(message.reasoning_text)
    : FUNCTION_THOUGHT_SIGNATURE

  const toolCallIds: Array<string> = []
  for (const toolCall of message.tool_calls ?? []) {
    modelParts.push({
      functionCall: {
        id: toolCall.id,
        name: sanitizeFunctionName(toolCall.function.name),
        args: parseFunctionArgs(toolCall.function.arguments),
      },
      thoughtSignature: reasoningSig,
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
    contents.push({ role: "user", parts: responseParts })
  }

  return contents
}

function buildTools(
  tools: Array<Tool> | null | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }
  const declarations = tools.map((tool) => ({
    name: sanitizeFunctionName(tool.function.name),
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
  if (declarations.length === 0) {
    return undefined
  }
  return [{ functionDeclarations: declarations }]
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
      const parts = buildUserParts(message.content)
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
    const effort = payload.reasoning_effort.toLowerCase()
    generationConfig.thinkingConfig =
      effort === "auto" ?
        {
          thinkingBudget: -1,
          includeThoughts: true,
        }
      : {
          thinkingLevel: effort,
          includeThoughts: effort !== "none",
        }
  }
  if (Object.keys(generationConfig).length > 0) {
    body.request.generationConfig = generationConfig
  }

  const tools = buildTools(payload.tools ?? undefined)
  if (tools) {
    body.request.tools = tools
  }

  return body
}
