import { isDumpSecretField } from "~/lib/request-dump-sanitizer"

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

const RESERVED = new Set([
  "model",
  "id",
  "type",
  "role",
  "name",
  "tool_use_id",
  "call_id",
  "tool_call_id",
  "signature",
  "thoughtSignature",
  "thought_signature",
  "reasoning_opaque",
  "encrypted_content",
  "mimeType",
  "mime_type",
  "media_type",
  "file_id",
  "previous_response_id",
  "prompt_cache_key",
  "session_id",
  "conversation_id",
  "user_id",
  "encoding",
  "format",
])

export interface SignedContent {
  signature: string
  fields: Array<string>
}

/** Only actual signed protocol content is sealed, not a tool's `signature` argument. */
function signedContent(
  value: Record<string, unknown>,
): SignedContent | undefined {
  // With multiple blocks, the top-level reasoning alias is an aggregate, not sealed by one signature.
  if (
    Array.isArray(value.reasoning_details)
    && value.reasoning_details.some((detail) => {
      const block = record(detail)
      return typeof block?.signature === "string" && block.signature.length > 0
    })
  )
    return undefined
  const signature =
    value.thoughtSignature
    ?? value.thought_signature
    ?? value.signature
    ?? value.reasoning_opaque
  if (
    typeof signature !== "string"
    || !signature
    || signature === "skip_thought_signature_validator"
  )
    return undefined
  const fields =
    value.thoughtSignature || value.thought_signature ? ["text", "functionCall"]
    : (
      value.type === "thinking"
      || value.type === "reasoning"
      || value.type === "reasoning.text"
      || (value.type === undefined
        && (typeof value.text === "string"
          || typeof value.thinking === "string"))
    ) ?
      ["thinking", "text", "reasoning"]
    : ["reasoning_text", "reasoning_content", "reasoning"]
  const present = fields.filter((key) => value[key] !== undefined)
  return present.length ? { signature, fields: present } : undefined
}

export function coveredContent(
  value: Record<string, unknown>,
  signed: SignedContent,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of signed.fields) {
    if (key === "functionCall") result.functionCall = value[key]
    else {
      if (result.text !== undefined && result.text !== value[key])
        throw new Error("Conflicting signed reasoning aliases")
      result.text = value[key]
    }
  }
  return result
}

/** Walk values without changing property names, protocol identifiers or opaque media. */
export function transformContent(
  value: unknown,
  text: (value: string, json: boolean, secretField?: boolean) => string,
  sealed?: (value: Record<string, unknown>, signed: SignedContent) => unknown,
  toolData = false,
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("Redaction content nesting exceeds 64 levels")
  if (typeof value === "string") return text(value, false)
  if (Array.isArray(value)) {
    const result = value.map((item) =>
      transformContent(item, text, sealed, toolData, depth + 1),
    )
    return result.every((item, index) => item === value[index]) ? value : result
  }
  const obj = record(value)
  if (!obj) return value
  if (
    Object.getPrototypeOf(obj) !== Object.prototype
    && Object.getPrototypeOf(obj) !== null
  )
    return value
  const signed = !toolData && signedContent(obj)
  if (signed && sealed) return sealed(obj, signed)
  const entries = Object.entries(obj).map(([key, nested]) => {
    if (
      !toolData
      && (RESERVED.has(key)
        || (key === "data"
          && (obj.type === "base64" || obj.encoding === "base64"))
        || ["inlineData", "inline_data", "input_audio", "file_data"].includes(
          key,
        ))
    )
      return [key, nested]
    const isArguments = key === "arguments" || key === "partial_json"
    if (isArguments && typeof nested === "string") {
      // Complete arguments can be parsed; streaming partial JSON must be escaped at its own layer.
      try {
        const parsed: unknown = JSON.parse(nested)
        const transformed = transformContent(
          parsed,
          text,
          undefined,
          true,
          depth + 1,
        )
        return [
          key,
          transformed === parsed ? nested : JSON.stringify(transformed),
        ]
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return [key, text(nested, true)]
      }
    }
    if (typeof nested === "string")
      return [key, text(nested, false, isDumpSecretField(key))]
    const args =
      toolData
      || key === "args"
      || ((key === "input" || key === "output")
        && [
          "tool_use",
          "server_tool_use",
          "function_call",
          "custom_tool_call",
          "function_call_output",
        ].includes(String(obj.type)))
    return [
      key,
      transformContent(
        nested,
        text,
        args ? undefined : sealed,
        args,
        depth + 1,
      ),
    ]
  })
  return entries.every(([key, nested]) => obj[key as string] === nested) ? obj
    : Object.fromEntries(entries)
}
