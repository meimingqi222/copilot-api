/**
 * Sanitizes IDs to be compatible with Anthropic's strict requirements.
 * Anthropic requires tool_use.id to match pattern: ^[a-zA-Z0-9_-]+$
 */

const INVALID_ID_CHAR_REGEX = /[^\w-]/g

/**
 * Sanitizes an ID by replacing invalid characters with underscores.
 * Anthropic API requires tool_use IDs to match: ^[a-zA-Z0-9_-]+$
 *
 * @param id - The original ID (e.g., from Copilot API)
 * @returns Sanitized ID safe for Anthropic API
 *
 * @example
 * sanitizeId("call_abc:123")     // "call_abc_123"
 * sanitizeId("call.abc/123")     // "call_abc_123"
 * sanitizeId("valid-id_123")     // "valid-id_123" (unchanged)
 */
export function sanitizeId(id: string): string {
  if (!id) return id

  // If already valid, return as-is (no collision risk)
  if (!INVALID_ID_CHAR_REGEX.test(id)) return id

  // Replace invalid chars and append a short hash of the original to avoid collisions
  const sanitized = id.replaceAll(INVALID_ID_CHAR_REGEX, "_")
  const hash = id
    .split("")
    .reduce((acc, c) => (acc * 31 + (c.codePointAt(0) ?? 0)) & 0xfffffff, 0)
    .toString(36)

  const result = `${sanitized}_${hash}`

  // Ensure it's not just underscores after sanitization
  if (!result.replaceAll("_", "")) {
    return `id_${Math.random().toString(36).slice(2, 11)}`
  }

  return result
}

/**
 * Validates if an ID matches Anthropic's requirements
 */
export function isValidAnthropicId(id: string): boolean {
  return /^[\w-]+$/.test(id)
}
