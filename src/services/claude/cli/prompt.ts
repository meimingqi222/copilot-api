/**
 * 调用方的 Anthropic messages → CLI 的一条 user 消息内容。
 *
 * 直译 magpie 的 `renderClaudePrompt()`
 * （`internal/gateway/claude_subscription.go:382`）。
 *
 * ## 为什么把整段 transcript 压成一条 user 文本
 *
 * 真 Claude Code 自己持有会话状态，而我们每回合起一个新进程。所以每回合
 * 都要把完整对话重新喂进去。压成文本而不是结构化的 messages，是因为
 * CLI 的 `--input-format stream-json` 只接受"一条 user 消息"，会话结构
 * 由 CLI 自己维护。
 *
 * ## 前缀稳定性（必须保持）
 *
 * 这个函数是**纯顺序拼接、无头无尾**：`render(msgs[0..N])` 必须是
 * `render(msgs[0..N+1])` 的字符串前缀。Anthropic 的 prompt cache 是前缀
 * 缓存，一旦这里引入了消息总数、时间戳、随机 id 之类的东西，跨回合缓存
 * 就会全量 miss。见 `docs/todo-claude-cli-transport.md` §6.1。
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/services/protocols/anthropic/types"

/** CLI user 消息里的一个内容块。 */
export type ClaudePromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }

type AnyContentBlock =
  | AnthropicAssistantContentBlock
  | AnthropicUserContentBlock

/** system 字段既可以是字符串，也可以是 text 块数组。 */
function systemText(system: AnthropicMessagesPayload["system"]): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n")
}

/**
 * tool_choice 的强制语义只能用自然语言表达：CLI 不接受 tool_choice 参数，
 * 而我们又不该把它塞进 system（那会踩到内容分类器）。
 */
function toolChoiceNote(
  toolChoice: AnthropicMessagesPayload["tool_choice"],
): string {
  if (!toolChoice) return ""
  if (toolChoice.type === "any") {
    return "\nYou must call at least one available tool before answering."
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return `\nYou must call the ${toolChoice.name} tool.`
  }
  return ""
}

function contentBlocks(
  message: AnthropicMessage,
): ReadonlyArray<AnyContentBlock> {
  return typeof message.content === "string" ?
      [{ type: "text", text: message.content }]
    : message.content
}

/** tool_result 的内容既可以是字符串，也可以是 text/image 块数组。 */
function toolResultBlocks(
  content: AnthropicToolResultBlock["content"],
): ReadonlyArray<
  AnthropicToolResultBlock["content"] extends string ? never
  : | { type: "text"; text: string }
    | { type: "image"; source: AnthropicImageSource }
> {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content
}

/**
 * 渲染 CLI 的 user 消息内容。
 *
 * 图片被"提起"成独立的 image 块（CLI 原生支持），其余全部走文本。
 */
export function renderClaudePrompt(
  payload: AnthropicMessagesPayload,
): Array<ClaudePromptBlock> {
  const blocks: Array<ClaudePromptBlock> = []
  let text = ""

  const flush = () => {
    if (text.length === 0) return
    blocks.push({ type: "text", text })
    text = ""
  }

  const system = systemText(payload.system)
  const note = toolChoiceNote(payload.tool_choice)
  if (system || note) {
    // 调用方的 system 不能进 CLI 的 system 字段：那正是 Anthropic 内容
    // 分类器读的地方。包成 user 内容，指令仍然是上下文的一部分。
    text += `<external_system_instructions>\n${system}${note}\n</external_system_instructions>\n\n`
  }

  for (const message of payload.messages) {
    text += `${message.role === "assistant" ? "Assistant" : "Human"}: `
    for (const block of contentBlocks(message)) {
      switch (block.type) {
        case "text": {
          text += block.text
          break
        }
        case "thinking": {
          text += block.thinking
          break
        }
        case "tool_use": {
          text += `\n[tool call ${block.name} id=${block.id} args=${JSON.stringify(block.input)}]`
          break
        }
        case "tool_result": {
          text += `\n[tool result id=${block.tool_use_id}${block.is_error ? " error" : ""}]\n`
          for (const inner of toolResultBlocks(block.content)) {
            if (inner.type === "text") {
              text += inner.text
            } else {
              flush()
              blocks.push({ type: "image", source: inner.source })
            }
          }
          break
        }
        case "image": {
          flush()
          blocks.push({ type: "image", source: block.source })
          break
        }
      }
    }
    text += "\n\n"
  }

  flush()
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[continue]" })
  }
  return blocks
}
