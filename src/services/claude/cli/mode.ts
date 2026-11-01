import type { ProviderConnection } from "~/lib/provider-connections"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import { renderClaudePrompt } from "~/services/claude/cli/prompt"
import { claudeSearchDeclaration } from "~/services/claude/cli/search-policy"

export type ClaudeCliMode = "print" | "interactive"

export function configuredClaudeCliMode(
  connection: ProviderConnection,
): ClaudeCliMode {
  return connection.metadata?.claudeCliMode === "interactive" ?
      "interactive"
    : "print"
}

/** SDK-only features must retain their existing wire and permission contracts. */
export function selectClaudeCliMode(
  connection: ProviderConnection,
  payload: AnthropicMessagesPayload,
): { mode: ClaudeCliMode; reason?: string } {
  if (configuredClaudeCliMode(connection) === "print") return { mode: "print" }
  if (payload.output_config?.format)
    return { mode: "print", reason: "JSON schema" }
  if (claudeSearchDeclaration(payload))
    return { mode: "print", reason: "native search permissions" }
  const blocks = renderClaudePrompt(payload)
  if (blocks.some((block) => block.type === "image"))
    return { mode: "print", reason: "image input" }
  if (
    Buffer.byteLength(
      blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n\n"),
    )
    > 400 * 1024
  )
    return { mode: "print", reason: "prompt exceeds 400 KB" }
  return { mode: "interactive" }
}
