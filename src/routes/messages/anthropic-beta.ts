export function hasClaudeCodeBeta(anthropicBeta?: string): boolean {
  if (!anthropicBeta) {
    return false
  }

  return anthropicBeta
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .some((token) => token.startsWith("claude-code"))
}
