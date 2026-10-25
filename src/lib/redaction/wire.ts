import { isDumpSecretField } from "~/lib/request-dump-sanitizer"
import { extractSignatureAlias } from "~/lib/thinking"

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
  "namespace",
  "server_label",
  "server_name",
  "item_id",
  "tool_use_id",
  "call_id",
  "tool_call_id",
  "signature",
  "thoughtSignature",
  "thought_signature",
  "reasoning_opaque",
  "thinking_signature",
  "reasoning_signature",
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
  "stream_options",
  "client_metadata",
  "tool_choice",
  "toolConfig",
  "tool_config",
  "reasoning_effort",
  "effort",
  "stop_reason",
  "finish_reason",
  "status",
  "object",
  "event",
  "include",
])

// These are vendor-validated definitions, not content. Only descriptions
// inside them may change; schema literals and grammars must stay executable.
const DEFINITIONS = new Set([
  "tools",
  "functions",
  "response_format",
  "output_format",
  "output_config",
  "generationConfig",
  "generation_config",
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
      return block && Boolean(extractSignatureAlias(block))
    })
  )
    return undefined
  const signature =
    value.thoughtSignature
    || value.thought_signature
    || extractSignatureAlias(value)
  if (
    typeof signature !== "string"
    || !signature
    || signature === "skip_thought_signature_validator"
  )
    return undefined
  const fields =
    value.thoughtSignature || value.thought_signature ?
      ["text", "functionCall"]
    : ["thinking", "text", "reasoning_text", "reasoning_content", "reasoning"]
  const present = fields.filter((key) =>
    key === "functionCall" ?
      value[key] !== undefined
    : typeof value[key] === "string" && value[key].length > 0,
  )
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
  text: (
    value: string,
    json: boolean,
    secretField?: boolean,
    toolInput?: boolean,
  ) => string,
  sealed?: (value: Record<string, unknown>, signed: SignedContent) => unknown,
  toolData: boolean | "output" | "definition" | "schema-map" = false,
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("Redaction content nesting exceeds 64 levels")
  if (typeof value === "string")
    return toolData === "definition" || toolData === "schema-map" ?
        value
      : text(value, false, false, toolData === true)
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
    if (toolData === "definition" || toolData === "schema-map") {
      if (
        toolData === "definition"
        && key === "description"
        && typeof nested === "string"
      )
        return [key, text(nested, false)]
      // Even an object-valued example/default can contain a `description` key.
      if (
        toolData === "definition"
        && ["enum", "const", "default", "examples", "example"].includes(key)
      )
        return [key, nested]
      return [
        key,
        transformContent(
          nested,
          text,
          undefined,
          // Property/definition names can themselves be `enum` or `default`.
          (
            toolData === "definition"
              && [
                "properties",
                "patternProperties",
                "$defs",
                "definitions",
                "dependentSchemas",
              ].includes(key)
          ) ?
            "schema-map"
          : "definition",
          depth + 1,
        ),
      ]
    }
    if (!toolData && DEFINITIONS.has(key))
      return [
        key,
        transformContent(nested, text, undefined, "definition", depth + 1),
      ]
    if (
      !toolData
      && (RESERVED.has(key)
        || (key === "data"
          && (obj.type === "base64" || obj.encoding === "base64"))
        || [
          "inlineData",
          "inline_data",
          "fileData",
          "file_data",
          "input_audio",
        ].includes(key)
        || (key === "image_url"
          && ["image_url", "input_image", "output_image"].includes(
            String(obj.type),
          ))
        || (key === "url" && obj.type === "url")
        || (key === "file_url" && obj.type === "input_file")
        || (key === "file" && obj.type === "file")
        || (key === "video_url" && obj.type === "video_url"))
    )
      return [key, nested]
    // Inside tool data these are ordinary property names, not another JSON layer.
    const isArguments =
      !toolData && (key === "arguments" || key === "partial_json")
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
        return [key, text(nested, true, false, true)]
      }
    }
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
          "response.custom_tool_call_input.done",
        ].includes(String(obj.type)))
      || (key === "response" && typeof obj.name === "string")
    const nestedToolData =
      !toolData && args && (key === "output" || key === "response") ?
        "output"
      : args
    if (typeof nested === "string")
      return [
        key,
        text(nested, false, isDumpSecretField(key), nestedToolData === true),
      ]
    return [
      key,
      transformContent(
        nested,
        text,
        args ? undefined : sealed,
        nestedToolData,
        depth + 1,
      ),
    ]
  })
  return entries.every(([key, nested]) => obj[key as string] === nested) ? obj
    : Object.fromEntries(entries)
}
