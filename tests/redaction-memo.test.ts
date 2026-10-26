import { beforeEach, expect, test } from "bun:test"

import {
  clearMaskMemoForTest,
  maskMemoHitsForTest,
  RedactionScope,
} from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"

const config = redactionConfigSchema.parse({ enabled: true })

beforeEach(() => {
  clearMaskMemoForTest()
})

function longText(seed: string): string {
  return `${`ordinary source line for ${seed}\n`.repeat(4000)}key sk-${"a".repeat(24)}\n`
}

test("a repeated text comes from the memo with the same output, metrics and restore", () => {
  const text = longText("memo-repeat")
  const first = new RedactionScope(config, "memo-repeat-user")
  const masked = first.mask({ messages: [{ role: "user", content: text }] })
  const firstDiagnostics = first.diagnostics()

  const second = new RedactionScope(config, "memo-repeat-user")
  const again = second.mask({ messages: [{ role: "user", content: text }] })
  const secondDiagnostics = second.diagnostics()

  expect(again).toEqual(masked)
  expect(secondDiagnostics.total).toBe(firstDiagnostics.total)
  expect(secondDiagnostics.detected).toBe(firstDiagnostics.detected)
  expect(secondDiagnostics.byKind).toEqual(firstDiagnostics.byKind)
  // The second request must come from the cross-request memo.
  expect(maskMemoHitsForTest()).toBeGreaterThan(0)
  // Placeholders in the cached output are still allowed for this request.
  expect(second.restore(again, "issuer")).toEqual({
    messages: [{ role: "user", content: text }],
  })
})

test("learning a new secret invalidates text that was cached before it", () => {
  const secret = ["memo", `${Date.now().toString(36)}7`, "Pass"].join("-")
  const plain = `the build log mentions ${secret} nowhere else\n`.repeat(20)
  const first = new RedactionScope(config, "memo-invalidate-user")
  expect(JSON.stringify(first.mask({ text: plain }))).toContain(secret)

  const learn = new RedactionScope(config, "memo-invalidate-user")
  learn.mask({ text: `DB_PASSWORD=${secret}` })

  const after = new RedactionScope(config, "memo-invalidate-user")
  const masked = after.mask({ text: plain }) as { text: string }
  expect(masked.text).not.toContain(secret)
})

test("a changed redaction config does not reuse the previous config's output", () => {
  const text = `${"ordinary source line\n".repeat(400)}ordinary\n`
  const first = new RedactionScope(config, "memo-config-user")
  expect((first.mask({ text }) as { text: string }).text).toContain("ordinary")

  const withWord = redactionConfigSchema.parse({
    enabled: true,
    words: ["ordinary"],
  })
  const second = new RedactionScope(withWord, "memo-config-user")
  const masked = second.mask({ text }) as { text: string }
  expect(masked.text).not.toContain("ordinary")
})

test("without an identity there is no cross-request memo to share", () => {
  const text = longText("memo-anonymous")
  const first = new RedactionScope(config)
  first.mask({ text })
  const second = new RedactionScope(config)
  second.mask({ text })
  // A fresh tenant means the same work is done again, not a shared hit.
  expect(maskMemoHitsForTest()).toBe(0)
})
