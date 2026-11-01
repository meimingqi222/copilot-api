import { LocalPayloadUnsupportedError } from "~/lib/error"
import { asRecord, asString } from "~/lib/json-shape"
import type {
  DecodeLoss,
  IRPart,
  IRTextPart,
  IRToolResultContent,
} from "~/services/ir/types"

interface ContentContext {
  role: "user" | "assistant" | "tool"
  path: string
  losses: Array<DecodeLoss>
}

function cacheControl(
  block: Record<string, unknown>,
): Pick<IRTextPart, "cacheControl"> {
  const value = asRecord(block.cache_control)
  if (value?.type !== "ephemeral") return {}
  return {
    cacheControl: {
      type: "ephemeral",
      ...(value.ttl === "5m" || value.ttl === "1h" ? { ttl: value.ttl } : {}),
    },
  }
}

function mediaPart(block: Record<string, unknown>): IRPart {
  const source = asRecord(block.source)
  const type = block.type === "document" ? "file" : "image"
  if (source?.type === "url" && typeof source.url === "string")
    return { type, source: { type: "url", url: source.url } }
  if (
    source?.type === "base64"
    && typeof source.data === "string"
    && typeof source.media_type === "string"
  )
    return {
      type,
      source: {
        type: "base64",
        mediaType: source.media_type,
        data: source.data,
      },
    }
  if (
    block.type === "document"
    && source?.type === "text"
    && typeof source.data === "string"
  )
    return { type: "text", text: source.data, ...cacheControl(block) }
  throw new LocalPayloadUnsupportedError(
    `Malformed Messages ${String(block.type)} source`,
  )
}

/** Runtime input can contain blocks newer than the public wire types. */
export function decodeMessagesContent(
  value: unknown,
  context: ContentContext,
): Array<IRPart> {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value))
    throw new LocalPayloadUnsupportedError("Malformed Messages content")
  return value.flatMap((raw, index) => {
    const block = asRecord(raw)
    if (!block)
      throw new LocalPayloadUnsupportedError("Malformed Messages content block")
    const path = `${context.path}[${index}]`
    const part = decodeBlock(block, { ...context, path })
    if (part) return [part]
    context.losses.push({
      path,
      feature: asString(block.type) ?? "unknown",
      action: "drop",
      reason: "content block has no equivalent on the target wire",
    })
    return []
  })
}

function decodeBlock(
  block: Record<string, unknown>,
  context: ContentContext,
): IRPart | undefined {
  if (block.type === "text") {
    if (typeof block.text !== "string")
      throw new LocalPayloadUnsupportedError("Malformed Messages text")
    return { type: "text", text: block.text, ...cacheControl(block) }
  }
  if (block.type === "image" || block.type === "document")
    return mediaPart(block)
  if (context.role === "assistant") return assistantBlock(block)
  if (context.role === "user" && block.type === "tool_result") {
    if (typeof block.tool_use_id !== "string" || !block.tool_use_id)
      throw new LocalPayloadUnsupportedError("Malformed Messages tool_result")
    const content = decodeMessagesContent(block.content ?? "", {
      ...context,
      role: "tool",
      path: `${context.path}.content`,
    }).filter(
      (part): part is IRToolResultContent =>
        part.type === "text" || part.type === "image" || part.type === "file",
    )
    return {
      type: "tool_result",
      callId: block.tool_use_id,
      content,
      ...(block.is_error === true ? { isError: true } : {}),
    }
  }
  if (context.role === "user" && block.type === "web_search_tool_result") {
    if (typeof block.tool_use_id !== "string" || !Array.isArray(block.content))
      return undefined
    return {
      type: "web_search_result",
      toolUseId: block.tool_use_id,
      results: block.content.flatMap((raw) => {
        const result = asRecord(raw)
        return typeof result?.url === "string" ?
            [
              {
                url: result.url,
                ...(asString(result.title) ?
                  { title: asString(result.title) }
                : {}),
                ...(asString(result.page_age) ?
                  { pageAge: asString(result.page_age) }
                : {}),
                ...(asString(result.encrypted_content) ?
                  { encryptedContent: asString(result.encrypted_content) }
                : {}),
              },
            ]
          : []
      }),
    }
  }
  return undefined
}

function assistantBlock(block: Record<string, unknown>): IRPart | undefined {
  if (block.type === "thinking") {
    if (typeof block.thinking !== "string")
      throw new LocalPayloadUnsupportedError("Malformed Messages thinking")
    const signature = asString(block.signature)
    return {
      type: "thinking",
      text: block.thinking,
      source: { wire: "messages" },
      ...(signature ? { signature, signedText: block.thinking } : {}),
    }
  }
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    if (
      typeof block.id !== "string"
      || typeof block.name !== "string"
      || !block.id
      || !block.name
    )
      throw new LocalPayloadUnsupportedError("Malformed Messages tool_use")
    if (block.type === "server_tool_use")
      return {
        type: "server_tool_use",
        id: block.id,
        name: block.name,
        input: JSON.stringify(block.input ?? {}),
      }
    return {
      type: "tool_call",
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    }
  }
  // redacted_thinking is opaque; it must never fall into the tool-call case.
  return undefined
}
