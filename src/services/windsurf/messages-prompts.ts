import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import type {
  ContentPart,
  Message,
  ToolCall,
} from "~/services/protocols/chat/types"
import { sanitizeWindsurfSystemPrompt } from "~/services/windsurf/content-policy-sanitizer"

export type WindsurfPrompt = Message & { cache?: boolean }

function marked(block: object): boolean {
  return "cache_control" in block && block.cache_control !== undefined
}

/** Keep instructions stable when Claude Code changes its per-request billing line. */
export function windsurfInstruction(text: string): string {
  return sanitizeWindsurfSystemPrompt(
    text.replace(/^x-anthropic-billing-header:[^\n]*(?:\n\n?|$)/, ""),
  )
}

/** Native prompt boundaries, not the flattened Chat view used for session/model selection. */
export function windsurfMessagesPrompts(payload: AnthropicMessagesPayload): {
  instructions: Array<WindsurfPrompt>
  messages: Array<WindsurfPrompt>
} {
  const instructions: Array<WindsurfPrompt> = []
  const system =
    typeof payload.system === "string" ?
      [{ type: "text" as const, text: payload.system }]
    : (payload.system ?? [])
  for (const block of system) {
    const text = windsurfInstruction(block.text)
    if (text.trim())
      instructions.push({ role: "user", content: text, cache: marked(block) })
    else if (marked(block) && instructions.length)
      instructions.at(-1)!.cache = true
  }
  const messages: Array<WindsurfPrompt> = []
  for (const message of payload.messages) {
    const blocks =
      typeof message.content === "string" ?
        [{ type: "text" as const, text: message.content }]
      : message.content
    let words: WindsurfPrompt | undefined
    let thought: WindsurfPrompt | undefined
    const images: Array<ContentPart> = []
    const calls: Array<ToolCall> = []
    let callCache = false
    const own: Array<WindsurfPrompt> = []
    for (const block of blocks) {
      if (block.type === "thinking") {
        if (thought) own.push(thought)
        thought = {
          role: "assistant",
          content: null,
          reasoning_text: block.thinking,
          ...(block.signature && { signature: block.signature }),
        }
      } else if (block.type === "text") {
        if (!block.text.trim()) {
          if (marked(block) && words) words.cache = true
          continue
        }
        words = {
          ...(thought ?? { role: message.role }),
          content:
            images.length ?
              [...images.splice(0), { type: "text", text: block.text }]
            : block.text,
          cache: marked(block),
        }
        thought = undefined
        own.push(words)
      } else if (block.type === "tool_use") {
        calls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
        callCache ||= marked(block)
      } else if (block.type === "tool_result") {
        const parts =
          typeof block.content === "string" ?
            [{ type: "text" as const, text: block.content }]
          : block.content
        const text =
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n\n") || "(no output)"
        const content: Array<ContentPart> = [
          { type: "text", text: block.is_error ? `Error: ${text}` : text },
        ]
        for (const part of parts) {
          if (part.type === "image" && part.source.type === "base64")
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${part.source.media_type};base64,${part.source.data}`,
              },
            })
        }
        own.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content,
          cache: marked(block) || (parts.length > 0 && marked(parts.at(-1)!)),
        })
      } else if (block.type === "image" && block.source.type === "base64") {
        const image: ContentPart = {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        }
        if (words) {
          words.content =
            typeof words.content === "string" ?
              [{ type: "text", text: words.content }, image]
            : [...(words.content ?? []), image]
          words.cache ||= marked(block)
        } else images.push(image)
      }
    }
    if (calls.length) {
      const last = own.at(-1)
      const prompt = thought
        ?? last ?? { role: "assistant" as const, content: null }
      prompt.tool_calls = calls
      prompt.cache ||= callCache
      if (prompt !== last) own.push(prompt)
      thought = undefined
    }
    if (thought) own.push(thought)
    if (images.length) own.push({ role: message.role, content: images })
    messages.push(...own)
  }
  return { instructions, messages }
}

/** Results precede notices/new user turns; unanswered calls get an explicit interruption. */
export function orderWindsurfPrompts(
  messages: Array<WindsurfPrompt>,
): Array<WindsurfPrompt> {
  const output: Array<WindsurfPrompt> = []
  const pending = new Set<string>()
  const notices: Array<WindsurfPrompt> = []
  let previousRole: Message["role"] | undefined
  const finishCalls = () => {
    for (const id of pending)
      output.push({
        role: "tool",
        tool_call_id: id,
        content: "Tool use was interrupted and did not produce a result.",
      })
    pending.clear()
    output.push(...notices.splice(0))
  }
  for (const message of messages) {
    if (message.role === "system") {
      const notice: WindsurfPrompt = { ...message, role: "user" }
      if (pending.size) notices.push(notice)
      else output.push(notice)
    } else if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id))
        continue
      output.push({ ...message, content: message.content || "(no output)" })
      if (!pending.size) finishCalls()
    } else if (message.role === "assistant") {
      // Parallel calls can be split across consecutive assistant blocks/turns.
      if (previousRole !== "assistant") finishCalls()
      output.push(message)
      for (const call of message.tool_calls ?? []) pending.add(call.id)
    } else {
      finishCalls()
      output.push(message)
    }
    previousRole = message.role
  }
  finishCalls()
  return output
}
