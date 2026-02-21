import { describe, it, expect } from "bun:test"

import { sanitizeId, isValidAnthropicId } from "~/lib/id-sanitizer"

describe("ID Sanitizer", () => {
  describe("sanitizeId", () => {
    it("should keep valid IDs unchanged", () => {
      expect(sanitizeId("valid-id")).toBe("valid-id")
      expect(sanitizeId("valid_id")).toBe("valid_id")
      expect(sanitizeId("valid123")).toBe("valid123")
      expect(sanitizeId("VALID_ID-123")).toBe("VALID_ID-123")
    })

    it("should replace colons with underscores", () => {
      expect(sanitizeId("call_abc:123")).toBe("call_abc_123")
      expect(sanitizeId("tool:function:arg")).toBe("tool_function_arg")
    })

    it("should replace dots with underscores", () => {
      expect(sanitizeId("call.abc.123")).toBe("call_abc_123")
    })

    it("should replace slashes with underscores", () => {
      expect(sanitizeId("call/abc/123")).toBe("call_abc_123")
    })

    it("should replace spaces with underscores", () => {
      expect(sanitizeId("call abc 123")).toBe("call_abc_123")
    })

    it("should handle multiple special characters", () => {
      expect(sanitizeId("call:abc.123/test-id")).toBe("call_abc_123_test-id")
    })

    it("should handle UUIDs with special characters", () => {
      expect(sanitizeId("call_123e4567-e89b-12d3-a456-426614174000")).toBe(
        "call_123e4567-e89b-12d3-a456-426614174000",
      )
      // UUID with colons (invalid format but should still sanitize)
      expect(sanitizeId("call:123e4567:e89b:12d3:a456:426614174000")).toBe(
        "call_123e4567_e89b_12d3_a456_426614174000",
      )
    })

    it("should generate a random ID if result would be empty", () => {
      const result = sanitizeId("!!!@@@###")
      expect(result).toMatch(/^id_[a-z0-9]+$/)
      expect(result.length).toBeGreaterThan(0)
    })

    it("should preserve empty string", () => {
      expect(sanitizeId("")).toBe("")
    })
  })

  describe("isValidAnthropicId", () => {
    it("should validate correct IDs", () => {
      expect(isValidAnthropicId("valid-id")).toBe(true)
      expect(isValidAnthropicId("valid_id")).toBe(true)
      expect(isValidAnthropicId("valid123")).toBe(true)
      expect(isValidAnthropicId("VALID_ID-123")).toBe(true)
    })

    it("should reject IDs with special characters", () => {
      expect(isValidAnthropicId("call:abc")).toBe(false)
      expect(isValidAnthropicId("call.abc")).toBe(false)
      expect(isValidAnthropicId("call/abc")).toBe(false)
      expect(isValidAnthropicId("call abc")).toBe(false)
    })

    it("should reject empty string", () => {
      expect(isValidAnthropicId("")).toBe(false)
    })
  })

  describe("round-trip validation", () => {
    it("should produce valid IDs after sanitization", () => {
      const testIds = [
        "call_abc:123",
        "call.abc.123",
        "tool/function/arg",
        "uuid-with-special:chars",
        "simple-id",
      ]

      for (const id of testIds) {
        const sanitized = sanitizeId(id)
        expect(isValidAnthropicId(sanitized)).toBe(true)
      }
    })
  })
})
