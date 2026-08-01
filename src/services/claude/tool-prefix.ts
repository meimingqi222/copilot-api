/**
 * Claude Code tool-name prefixing.
 *
 * Real Claude Code prefixes every non-builtin tool name with `_` on the wire
 * (a transport detail), stripping it on receive. Builtin server-side tools
 * (`web_search`, `code_execution`, `text_editor`, `computer`) are recognized
 * by exact name and MUST NOT be prefixed. Mimicking this keeps the OAuth
 * request fingerprint aligned with CC.
 *
 * Ported from oh-my-pi packages/ai/src/providers/anthropic.ts (767-829).
 */

const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([
  "web_search",
  "code_execution",
  "text_editor",
  "computer",
])

/** CC's tool-name prefix (always `_`). */
export const claudeToolPrefix = "_"

/**
 * Applies the CC `_` prefix to a non-builtin tool name.
 *
 * Always prepends (no "already prefixed" short-circuit): the prefix is a wire
 * transport detail applied once, and stripping removes exactly one leading
 * underscore. Skipping names that already start with `_` would make a tool
 * literally named `_foo` lose its underscore on the return trip.
 */
export function applyClaudeToolPrefix(name: string): string {
  if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name
  return `${claudeToolPrefix}${name}`
}

/** Removes one leading `_` prefix from a tool name (the inverse of apply). */
export function stripClaudeToolPrefix(name: string): string {
  if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase()))
    return name
  return name.slice(claudeToolPrefix.length)
}
