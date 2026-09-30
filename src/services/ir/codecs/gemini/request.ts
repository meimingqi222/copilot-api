import type {
  GeminiContent,
  GeminiGenerateContentRequest,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiTool,
  GeminiToolConfig,
} from "~/services/protocols/gemini"
import type {
  IRImagePart,
  IRPart,
  IRThinkingPart,
  IRTool,
  IRToolChoice,
  IRToolResultPart,
  IRTurn,
  RequestIR,
} from "~/services/ir/types"

import { decodeGeminiPart } from "./part"

function decodeGeminiContents(contents: Array<GeminiContent>): Array<IRTurn> {
  return contents.map((content) => {
    const role: IRTurn["role"] = content.role === "model" ? "assistant" : "user"
    return {
      role,
      parts: content.parts
        .map(decodeGeminiPart)
        .filter((part): part is IRPart => part !== undefined),
      source: { wire: "gemini" },
    }
  })
}

function decodeGeminiToolChoice(
  toolConfig: GeminiToolConfig | undefined,
): IRToolChoice | undefined {
  const config = toolConfig?.functionCallingConfig
  if (!config) return undefined
  const allowed = config.allowedFunctionNames
  if (config.mode === "NONE") return { type: "none" }
  if (config.mode === "AUTO")
    return allowed && allowed.length > 0 ?
        { type: "allowed", mode: "auto", names: allowed }
      : { type: "auto" }
  return (
    allowed && allowed.length === 1 ? { type: "tool", name: allowed[0] }
    : allowed && allowed.length > 0 ?
      { type: "allowed", mode: "required", names: allowed }
    : { type: "required" }
  )
}

function decodeGeminiTools(tools: Array<GeminiTool> | undefined): {
  tools?: Array<IRTool>
  webSearch: boolean
} {
  const declared: Array<IRTool> = []
  let webSearch = false
  for (const tool of tools ?? []) {
    if (tool.google_search || tool.googleSearch) webSearch = true
    for (const fn of tool.functionDeclarations ?? [])
      declared.push({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? {},
      })
  }
  return { ...(declared.length > 0 && { tools: declared }), webSearch }
}

export function decodeGeminiRequest(
  payload: GeminiGenerateContentRequest,
): RequestIR {
  const systemText = payload.systemInstruction?.parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string" && text !== "")
    .join("\n\n")
  const { tools, webSearch } = decodeGeminiTools(payload.tools)
  const config = payload.generationConfig
  const thinking = config?.thinkingConfig
  return {
    model: payload.model ?? "",
    source: { wire: "gemini" },
    instructions:
      systemText ?
        [
          {
            role: "system",
            parts: [{ type: "text", text: systemText }],
            source: { wire: "gemini" },
          },
        ]
      : [],
    turns: decodeGeminiContents(payload.contents),
    ...(tools && { tools }),
    ...(payload.toolConfig && {
      toolChoice: decodeGeminiToolChoice(payload.toolConfig),
    }),
    generation: {
      maxOutputTokens: config?.maxOutputTokens,
      temperature: config?.temperature,
      topP: config?.topP,
      topK: config?.topK,
      stopSequences: config?.stopSequences,
      ...(webSearch && { webSearch: true }),
      ...(thinking && {
        reasoning: {
          ...(thinking.thinkingBudget !== undefined && {
            budgetTokens: thinking.thinkingBudget,
          }),
          ...(thinking.thinkingLevel && {
            effort: geminiLevelToEffort(thinking.thinkingLevel),
          }),
          ...(thinking.includeThoughts !== undefined && {
            display: thinking.includeThoughts ? "summarized" : "omitted",
          }),
        },
      }),
    },
  }
}

function geminiLevelToEffort(
  level: string,
): "none" | "minimal" | "low" | "medium" | "high" | undefined {
  switch (level.toLowerCase()) {
    case "none":
      return "none"
    case "minimal":
      return "minimal"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    default:
      return undefined
  }
}

function effortToGeminiLevel(effort: string): string | undefined {
  if (effort === "minimal") return "minimal"
  if (effort === "low") return "low"
  if (effort === "medium") return "medium"
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high"
  return undefined
}

function toBase64Image(part: IRImagePart): GeminiPart | undefined {
  if (part.source.type === "base64")
    return {
      inlineData: { mimeType: part.source.mediaType, data: part.source.data },
    }
  return /^https?:\/\//i.test(part.source.url) ?
      { fileData: { fileUri: part.source.url } }
    : undefined
}

/** Gemini carries tool results as `functionResponse` parts inside a user content. */
function toFunctionResponsePart(
  part: IRToolResultPart,
  names: Map<string, string>,
): GeminiPart {
  const text = part.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n\n")
  let result: unknown = text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null) result = parsed
  } catch {
    /* Non-JSON tool output is passed through as a string. */
  }
  return {
    functionResponse: {
      name: names.get(part.callId) ?? part.callId,
      response: { result },
    },
  }
}

function thinkingToGeminiPart(part: IRThinkingPart): GeminiPart {
  // The preflight drops signatures that are not valid for this wire; the
  // readable reasoning text is still replayed as a thought part.
  const replayable =
    part.signature !== undefined
    && part.signedText === part.text
    && part.source.wire === "gemini"
  return {
    text: part.text,
    thought: true,
    ...(replayable && { thoughtSignature: part.signature }),
  }
}

function toolCallNameIndex(turns: Array<IRTurn>): Map<string, string> {
  const names = new Map<string, string>()
  for (const turn of turns)
    for (const part of turn.parts)
      if (part.type === "tool_call") names.set(part.id, part.name)
  return names
}

function encodeGeminiContents(
  turns: Array<IRTurn>,
  names: Map<string, string>,
): Array<GeminiContent> {
  const contents: Array<GeminiContent> = []
  let pendingResults: Array<GeminiPart> = []
  const flushResults = (): void => {
    if (pendingResults.length === 0) return
    contents.push({ role: "user", parts: pendingResults })
    pendingResults = []
  }
  for (const turn of turns) {
    if (turn.role === "tool") {
      for (const part of turn.parts)
        if (part.type === "tool_result")
          pendingResults.push(toFunctionResponsePart(part, names))
      continue
    }
    if (turn.role === "user") {
      const parts: Array<GeminiPart> = []
      for (const part of turn.parts) {
        if (part.type === "tool_result") {
          pendingResults.push(toFunctionResponsePart(part, names))
          continue
        }
        if (part.type === "text") parts.push({ text: part.text })
        if (part.type === "image") {
          const image = toBase64Image(part)
          if (image) parts.push(image)
        }
      }
      if (pendingResults.length > 0) {
        contents.push({ role: "user", parts: [...pendingResults, ...parts] })
        pendingResults = []
      } else if (parts.length > 0) {
        contents.push({ role: "user", parts })
      }
      continue
    }
    flushResults()
    const parts: Array<GeminiPart> = []
    for (const part of turn.parts) {
      if (part.type === "thinking") parts.push(thinkingToGeminiPart(part))
      if (part.type === "text") parts.push({ text: part.text })
      if (part.type === "tool_call") {
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(part.arguments)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>
        } catch {
          /* Truncated tool JSON cannot be represented; send an empty object. */
        }
        parts.push({ functionCall: { name: part.name, args } })
      }
    }
    if (parts.length > 0) contents.push({ role: "model", parts })
  }
  flushResults()
  return contents
}

function encodeGeminiToolConfig(
  choice: IRToolChoice | undefined,
): GeminiToolConfig | undefined {
  if (!choice) return undefined
  if (choice.type === "none") return { functionCallingConfig: { mode: "NONE" } }
  if (choice.type === "required")
    return { functionCallingConfig: { mode: "ANY" } }
  if (choice.type === "tool")
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [choice.name],
      },
    }
  if (choice.type === "allowed")
    return {
      functionCallingConfig: {
        mode: choice.mode === "required" ? "ANY" : "AUTO",
        allowedFunctionNames: choice.names,
      },
    }
  return { functionCallingConfig: { mode: "AUTO" } }
}

function encodeGeminiGenerationConfig(
  ir: RequestIR,
): GeminiGenerationConfig | undefined {
  const generation = ir.generation
  const reasoning = generation?.reasoning
  const thinkingConfig: NonNullable<GeminiGenerationConfig["thinkingConfig"]> =
    {}
  if (reasoning?.budgetTokens !== undefined)
    thinkingConfig.thinkingBudget = reasoning.budgetTokens
  else if (reasoning?.mode === "disabled") thinkingConfig.thinkingBudget = 0
  const level =
    reasoning?.effort === "none" ? undefined
    : reasoning?.effort ? effortToGeminiLevel(reasoning.effort)
    : undefined
  if (level) thinkingConfig.thinkingLevel = level
  if (reasoning?.effort === "none") thinkingConfig.thinkingBudget = 0
  if (reasoning?.display !== undefined)
    thinkingConfig.includeThoughts = reasoning.display === "summarized"
  const config: GeminiGenerationConfig = {
    ...(generation?.maxOutputTokens !== undefined && {
      maxOutputTokens: generation.maxOutputTokens,
    }),
    ...(generation?.temperature !== undefined && {
      temperature: generation.temperature,
    }),
    ...(generation?.topP !== undefined && { topP: generation.topP }),
    ...(generation?.topK !== undefined && { topK: generation.topK }),
    ...(generation?.stopSequences && {
      stopSequences: generation.stopSequences,
    }),
    ...(Object.keys(thinkingConfig).length > 0 && { thinkingConfig }),
  }
  return Object.keys(config).length > 0 ? config : undefined
}

export function encodeGeminiRequest(
  ir: RequestIR,
  options: { stream?: boolean } = {},
): GeminiGenerateContentRequest {
  const systemText = ir.instructions
    .flatMap((instruction) => instruction.parts)
    .map((part) => part.text)
    .join("\n\n")
  const tools: Array<GeminiTool> = []
  if (ir.tools?.length)
    tools.push({
      functionDeclarations: ir.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description && { description: tool.description }),
        parameters: tool.parameters,
      })),
    })
  if (ir.generation?.webSearch) tools.push({ google_search: {} })
  const toolConfig = encodeGeminiToolConfig(ir.toolChoice)
  const generationConfig = encodeGeminiGenerationConfig(ir)
  return {
    ...(ir.model && { model: ir.model }),
    contents: encodeGeminiContents(ir.turns, toolCallNameIndex(ir.turns)),
    ...(systemText && {
      systemInstruction: { parts: [{ text: systemText }] },
    }),
    ...(tools.length > 0 && { tools }),
    ...(toolConfig && { toolConfig }),
    ...(generationConfig && { generationConfig }),
    ...(options.stream !== undefined && { stream: options.stream }),
  }
}
