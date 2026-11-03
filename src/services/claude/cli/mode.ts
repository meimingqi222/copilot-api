import type { ProviderConnection } from "~/lib/provider-connections"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import { renderClaudePrompt } from "~/services/claude/cli/prompt"
import { claudeSearchDeclaration } from "~/services/claude/cli/search-policy"
import { LocalPayloadUnsupportedError } from "~/lib/error"

type ClaudeCliMode = "print" | "interactive"

export function configuredClaudeCliMode(
  connection: ProviderConnection,
): ClaudeCliMode {
  return connection.metadata?.claudeCliMode === "interactive" ?
      "interactive"
    : "print"
}

/** A saved interactive choice never starts a print request. */
export function selectClaudeCliMode(
  connection: ProviderConnection,
  payload: AnthropicMessagesPayload,
): { mode: ClaudeCliMode } {
  if (configuredClaudeCliMode(connection) === "print") return { mode: "print" }
  let reason: string | undefined
  if (payload.output_config?.format) reason = "JSON Schema"
  else if (claudeSearchDeclaration(payload))
    reason = "native search permissions"
  const blocks = renderClaudePrompt(payload)
  if (
    Buffer.byteLength(
      blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n\n"),
    )
    > 400 * 1024
  )
    reason = "prompt exceeds 400 KB"
  if (reason)
    throw new LocalPayloadUnsupportedError(
      `Interactive mode cannot handle ${reason}; select Print (-p) in the Claude account settings for this request`,
    )
  return { mode: "interactive" }
}
