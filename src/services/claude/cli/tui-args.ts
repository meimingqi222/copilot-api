import { CLAUDE_MCP_SERVER_NAME } from "~/services/claude/cli/mcp-names"

/** Keep real interactive permissions; only this run's MCP tools are allowed. */
export function interactiveClaudeArgs(
  args: ReadonlyArray<string>,
  sessionId: string,
): Array<string> {
  const flags = new Set([
    "-p",
    "--print",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ])
  const pairs = new Set([
    "--input-format",
    "--output-format",
    "--thinking-display",
    "--permission-mode",
    "--permission-prompt-tool",
  ])
  const result: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i])) continue
    if (pairs.has(args[i])) {
      i++
      continue
    }
    if (args[i] === "--json-schema")
      throw new Error("JSON schema requires Claude print mode")
    result.push(args[i])
  }
  return [
    ...result,
    "--permission-mode",
    "default",
    "--allowedTools",
    `mcp__${CLAUDE_MCP_SERVER_NAME}`,
    "--no-chrome",
    "--session-id",
    sessionId,
  ]
}

/** Terminal control bytes must never escape bracketed paste into executable keys. */
export function pasteClaudeText(text: string): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- Untrusted text cannot send terminal keys.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  return `\x1b[200~${/^[/!#&]/.test(clean.trimStart()) ? "\n" : ""}${clean}\x1b[201~`
}
