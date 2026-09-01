import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

/**
 * Cheap token estimate used on the request path.
 *
 * Loading a BPE vocabulary costs well over 100MB, and encoding a large prompt
 * allocates a token array proportional to the entire context. That made local
 * usage estimation capable of exhausting small servers before the request was
 * even sent upstream. Four UTF-8 bytes per token matches oh-my-pi's default
 * estimator and is sufficient here because upstream usage remains authoritative.
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4)
}

interface TokenCounter {
  count: (text: string) => number
}

const approximateCounter: TokenCounter = {
  count: estimateTextTokens,
}

/** Calculate tokens for tool calls. */
function calculateToolCallsTokens(
  toolCalls: Array<ToolCall>,
  counter: TokenCounter,
  constants: ReturnType<typeof getModelConstants>,
): number {
  let tokens = 0
  for (const toolCall of toolCalls) {
    tokens += constants.funcInit
    tokens += counter.count(JSON.stringify(toolCall))
  }
  tokens += constants.funcEnd
  return tokens
}

/**
 * Wire-only placeholder — must match EMPTY_TEXT_PLACEHOLDER in
 * services/protocols/openai/chat-to-messages.ts (lib→services import would
 * violate repo layering, cf. ReasoningPartLike in lib/thinking.ts).
 * Defensive on current call sites: getTokenCount only sees client payloads,
 * never the translated outbound payload where this placeholder is synthesized,
 * so this branch is dead today (see tests/tokenizer.test.ts drift guard).
 */
export const PLACEHOLDER_TEXT = "(no content)"

function isPlaceholderText(text: string): boolean {
  return text === PLACEHOLDER_TEXT
}

/** Calculate tokens for content parts. */
function calculateContentPartsTokens(
  contentParts: Array<ContentPart>,
  counter: TokenCounter,
): number {
  let tokens = 0
  for (const part of contentParts) {
    if (part.type === "image_url") {
      tokens +=
        part.image_url.url.startsWith("data:") ?
          85
        : counter.count(part.image_url.url) + 85
    } else if (part.text && !isPlaceholderText(part.text)) {
      tokens += counter.count(part.text)
    }
  }
  return tokens
}

function isPlaceholderMessageContent(content: unknown): boolean {
  return (
    Array.isArray(content)
    && content.length === 1
    && (content[0] as { type?: string; text?: string }).type === "text"
    && isPlaceholderText((content[0] as { text?: string }).text ?? "")
  )
}

/** Calculate tokens for a single message. */
function calculateMessageTokens(
  message: Message,
  counter: TokenCounter,
  constants: ReturnType<typeof getModelConstants>,
): number {
  if (isPlaceholderMessageContent(message.content)) return 0
  const tokensPerMessage = 3
  const tokensPerName = 1
  let tokens = tokensPerMessage
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === "string" && !isPlaceholderText(value)) {
      tokens += counter.count(value)
    }
    if (key === "name") {
      tokens += tokensPerName
    }
    if (key === "tool_calls") {
      tokens += calculateToolCallsTokens(
        value as Array<ToolCall>,
        counter,
        constants,
      )
    }
    if (key === "content" && Array.isArray(value)) {
      tokens += calculateContentPartsTokens(
        value as Array<ContentPart>,
        counter,
      )
    }
  }
  return tokens
}

function getModelConstants(model: Model) {
  return model.id === "gpt-3.5-turbo" || model.id === "gpt-4" ?
      {
        funcInit: 10,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }
    : {
        funcInit: 7,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }
}

function calculateParameterTokens(
  key: string,
  prop: unknown,
  context: {
    counter: TokenCounter
    constants: ReturnType<typeof getModelConstants>
  },
): number {
  const { counter, constants } = context
  let tokens = constants.propKey

  if (typeof prop !== "object" || prop === null) {
    return tokens
  }

  const param = prop as {
    type?: string
    description?: string
    enum?: Array<unknown>
    [key: string]: unknown
  }

  const paramType = param.type || "string"
  let paramDesc = param.description || ""

  if (param.enum && Array.isArray(param.enum)) {
    tokens += constants.enumInit
    for (const item of param.enum) {
      tokens += constants.enumItem
      tokens += counter.count(String(item))
    }
  }

  if (paramDesc.endsWith(".")) {
    paramDesc = paramDesc.slice(0, -1)
  }

  tokens += counter.count(`${key}:${paramType}:${paramDesc}`)

  const excludedKeys = new Set(["type", "description", "enum"])
  for (const propertyName of Object.keys(param)) {
    if (!excludedKeys.has(propertyName)) {
      const propertyValue = param[propertyName]
      const propertyText =
        typeof propertyValue === "string" ? propertyValue : (
          JSON.stringify(propertyValue)
        )
      tokens += counter.count(`${propertyName}:${propertyText}`)
    }
  }

  return tokens
}

function calculateParametersTokens(
  parameters: unknown,
  counter: TokenCounter,
  constants: ReturnType<typeof getModelConstants>,
): number {
  if (!parameters || typeof parameters !== "object") {
    return 0
  }

  const params = parameters as Record<string, unknown>
  let tokens = 0

  for (const [key, value] of Object.entries(params)) {
    if (key === "properties") {
      const properties = value as Record<string, unknown>
      if (Object.keys(properties).length > 0) {
        tokens += constants.propInit
        for (const propKey of Object.keys(properties)) {
          tokens += calculateParameterTokens(propKey, properties[propKey], {
            counter,
            constants,
          })
        }
      }
    } else {
      const paramText =
        typeof value === "string" ? value : JSON.stringify(value)
      tokens += counter.count(`${key}:${paramText}`)
    }
  }

  return tokens
}

function calculateToolTokens(
  tool: Tool,
  counter: TokenCounter,
  constants: ReturnType<typeof getModelConstants>,
): number {
  let tokens = constants.funcInit
  const func = tool.function
  let description = func.description || ""
  if (description.endsWith(".")) {
    description = description.slice(0, -1)
  }
  tokens += counter.count(`${func.name}:${description}`)
  if (typeof func.parameters === "object" && func.parameters !== null) {
    tokens += calculateParametersTokens(func.parameters, counter, constants)
  }
  return tokens
}

/** Estimate tokens for tools based on the existing chat-format overheads. */
export function numTokensForTools(
  tools: Array<Tool>,
  constants: ReturnType<typeof getModelConstants>,
): number {
  let tokenCount = 0
  for (const tool of tools) {
    tokenCount += calculateToolTokens(tool, approximateCounter, constants)
  }
  tokenCount += constants.funcEnd
  return tokenCount
}

/**
 * Local token estimate for a chat completions payload.
 *
 * This deliberately avoids model BPE tokenizers. The estimate is used for
 * local logging and fallback streaming usage only; provider-reported usage is
 * authoritative.
 */
export function getTokenCount(
  payload: ChatCompletionsPayload,
  model: Model,
): Promise<{ input: number; history: number }> {
  const constants = getModelConstants(model)

  let history = 0
  let messagesTokens = 0
  for (const message of payload.messages) {
    const tokens = calculateMessageTokens(
      message,
      approximateCounter,
      constants,
    )
    messagesTokens += tokens
    if (message.role === "assistant") {
      history += tokens
    }
  }

  // Every reply is primed with <|start|>assistant<|message|>.
  if (payload.messages.length > 0) {
    messagesTokens += 3
  }

  let input = messagesTokens
  if (payload.tools && payload.tools.length > 0) {
    input += numTokensForTools(payload.tools, constants)
  }

  return Promise.resolve({ input, history })
}
