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

  // Replace any character that's not alphanumeric, hyphen, or underscore
  const sanitized = id.replaceAll(INVALID_ID_CHAR_REGEX, "_")

  // Ensure it's not just underscores after sanitization
  if (!sanitized.replaceAll("_", "")) {
    return `id_${Math.random().toString(36).slice(2, 11)}`
  }

  return sanitized
}

/**
 * Validates if an ID matches Anthropic's requirements
 */
export function isValidAnthropicId(id: string): boolean {
  return /^[\w-]+$/.test(id)
}
