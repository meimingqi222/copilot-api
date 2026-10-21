import { LocalPayloadUnsupportedError } from "~/lib/error"
import { encodeAIStudioToolSchema } from "~/services/aistudio/tool-schema"
import type {
  GeminiGenerateContentRequest,
  GeminiPart,
} from "~/services/protocols/gemini/types"

export {
  decodeGenerateStream,
  collectGenerateResponse,
} from "~/services/aistudio/stream"

function unsupported(message: string): never {
  throw new LocalPayloadUnsupportedError(`AI Studio: ${message}`)
}

function keys(value: object, allowed: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) unsupported(`unsupported field ${key}`)
  }
}

function encodeStruct(value: Record<string, unknown>): unknown[] {
  return [Object.entries(value).map(([key, item]) => [key, encodeValue(item)])]
}

function encodeValue(value: unknown): unknown[] {
  if (value === null) return [0]
  if (typeof value === "number" && Number.isFinite(value)) return [null, value]
  if (typeof value === "string") return [null, null, value]
  if (typeof value === "boolean") return [null, null, null, value]
  if (Array.isArray(value))
    return [null, null, null, null, null, [value.map(encodeValue)]]
  if (typeof value === "object" && value)
    return [
      null,
      null,
      null,
      null,
      encodeStruct(value as Record<string, unknown>),
    ]
  return unsupported("non-JSON tool value")
}

function encodePart(part: GeminiPart): unknown[] {
  keys(part, [
    "text",
    "inlineData",
    "fileData",
    "functionCall",
    "functionResponse",
    "thought",
    "thoughtSignature",
  ])
  const wire: unknown[] = []
  const variants = [
    part.text,
    part.inlineData,
    part.fileData,
    part.functionCall,
    part.functionResponse,
  ].filter((v) => v !== undefined)
  if (variants.length > 1 || (!variants.length && !part.thoughtSignature))
    unsupported("part must have one content variant")
  if (part.text !== undefined) wire[1] = part.text
  if (part.inlineData) {
    keys(part.inlineData, ["mimeType", "data"])
    wire[2] = [part.inlineData.mimeType, part.inlineData.data]
  }
  if (part.fileData) {
    keys(part.fileData, ["mimeType", "fileUri"])
    wire[6] = [part.fileData.mimeType, part.fileData.fileUri]
  }
  if (part.functionCall) {
    keys(part.functionCall, ["name", "args", "id"])
    wire[10] = [
      part.functionCall.name,
      encodeStruct(part.functionCall.args ?? {}),
      part.functionCall.id,
    ]
    // The Playground's explicit opt-out supports histories from other wires.
    wire[14] = part.thoughtSignature ?? "skip_thought_signature_validator"
  }
  if (part.functionResponse) {
    keys(part.functionResponse, ["name", "response", "id"])
    wire[11] = [
      part.functionResponse.name,
      encodeStruct(part.functionResponse.response),
      part.functionResponse.id,
    ]
  }
  if (part.thought !== undefined) wire[12] = part.thought
  if (part.thoughtSignature !== undefined) wire[14] = part.thoughtSignature
  return wire
}

function tools(payload: GeminiGenerateContentRequest): unknown[] {
  const choice = payload.toolConfig?.functionCallingConfig
  if (payload.toolConfig) keys(payload.toolConfig, ["functionCallingConfig"])
  if (choice) {
    keys(choice, ["mode", "allowedFunctionNames"])
    if (
      choice.allowedFunctionNames?.length
      || !["AUTO", "NONE"].includes(choice.mode)
    )
      unsupported("strict tool choice is not representable")
  }
  if (choice?.mode === "NONE") return []
  return (payload.tools ?? []).flatMap((tool) => {
    keys(tool, ["functionDeclarations", "google_search", "googleSearch"])
    const result: unknown[] = []
    if (tool.functionDeclarations?.length)
      result.push([
        null,
        tool.functionDeclarations.map((fn) => {
          keys(fn, ["name", "description", "parameters"])
          const encoded = encodeAIStudioToolSchema(
            fn.parameters ?? { type: "object" },
            fn.description,
          )
          return [fn.name, encoded.description, encoded.wire]
        }),
      ])
    if (tool.google_search || tool.googleSearch) {
      keys(tool.google_search ?? tool.googleSearch ?? {}, [])
      result.push([null, null, null, [null, [[]]]])
    }
    return result
  })
}

function config(
  payload: GeminiGenerateContentRequest,
  model: string,
  metadata?: Record<string, unknown>,
): unknown[] {
  const cfg = payload.generationConfig ?? {}
  keys(cfg, [
    "maxOutputTokens",
    "temperature",
    "topP",
    "topK",
    "stopSequences",
    "thinkingConfig",
  ])
  const wire: unknown[] = []
  wire[1] = cfg.stopSequences
  const limit =
    (
      typeof metadata?.outputTokenLimit === "number"
      && metadata.outputTokenLimit > 0
    ) ?
      metadata.outputTokenLimit
    : 8192
  wire[3] = cfg.maxOutputTokens ?? Math.min(8192, limit)
  wire[4] = cfg.temperature
  wire[5] = cfg.topP
  wire[6] = cfg.topK
  wire[13] = 1
  const defaults: unknown[] | undefined =
    Array.isArray(metadata?.thinkingConfig) ?
      metadata.thinkingConfig
    : undefined
  if (defaults) wire[16] = [1, defaults[0], null, defaults[5]]
  else if (/gemini-3/.test(model))
    wire[16] = [1, null, null, model.includes("flash-lite") ? 4 : 1]
  const thinking = cfg.thinkingConfig
  if (thinking) {
    keys(thinking, ["thinkingBudget", "thinkingLevel", "includeThoughts"])
    const levels: Record<string, number> = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      MINIMAL: 4,
    }
    const level = thinking.thinkingLevel?.toUpperCase()
    if (
      level
      && (!levels[level]
        || (Array.isArray(defaults?.[6]) ?
          !defaults[6].includes(levels[level])
        : level === "MINIMAL" && !model.includes("flash-lite")))
    )
      unsupported("unsupported thinking level for model")
    wire[16] = [
      1,
      thinking.thinkingBudget ?? (wire[16] as unknown[] | undefined)?.[1],
      null,
      level ? levels[level] : (wire[16] as unknown[] | undefined)?.[3],
    ]
  }
  return wire
}

/** Root field 4 is deliberately empty: the caller supplies a fresh WAA proof. */
export function encodeGenerateRequest(
  payload: GeminiGenerateContentRequest,
  model: string,
  metadata?: Record<string, unknown>,
): { body: unknown[]; binding: string } {
  keys(payload, [
    "model",
    "contents",
    "systemInstruction",
    "tools",
    "toolConfig",
    "generationConfig",
    "stream",
  ])
  if (!payload.contents.length) unsupported("contents cannot be empty")
  const body: unknown[] = []
  body[0] = model.startsWith("models/") ? model : `models/${model}`
  body[1] = payload.contents.map((content) => {
    keys(content, ["role", "parts"])
    if (!content.parts.length) unsupported("content parts cannot be empty")
    if (content.role && !["user", "model"].includes(content.role))
      unsupported("unsupported content role")
    return [content.parts.map(encodePart), content.role ?? "user"]
  })
  body[3] = config(payload, model, metadata)
  if (payload.systemInstruction) {
    keys(payload.systemInstruction, ["role", "parts"])
    body[5] = [payload.systemInstruction.parts.map(encodePart), "user"]
  }
  body[6] = tools(payload)
  body[10] = 1
  if (
    payload.tools?.some((t) => t.functionDeclarations?.length)
    && payload.tools.some((t) => t.google_search || t.googleSearch)
  )
    body[13] = [null, null, true]
  const binding = payload.contents
    .flatMap((c) => c.parts.map((p) => p.text ?? p.inlineData?.data ?? ""))
    .join(" ")
  return { body, binding }
}
