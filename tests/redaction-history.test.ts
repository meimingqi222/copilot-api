import { beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { RedactionScope } from "~/lib/redaction/context"
import {
  appendRedactionHistory,
  flushRedactionHistory,
  summarizeRedactionHistory,
} from "~/lib/redaction/history"
import { redactionConfigSchema } from "~/lib/redaction/rules"

const KEY = "sk-historytest1234567890ab"
const DAY = 24 * 60 * 60_000

beforeEach(async () => {
  await flushRedactionHistory()
  await fs.rm(PATHS.REDACTION_DIR, { recursive: true, force: true })
})

function diagnosticsFor(text: string) {
  const scope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, personal: true }),
  )
  scope.maskText(text)
  return scope.diagnostics()
}

test("history keeps per-day counts across days without any value", async () => {
  const route = {
    client: "Claude Code",
    upstreams: [{ id: "conn-1", name: "Copilot", model: "gpt-5" }],
  }
  const masked = diagnosticsFor(`${KEY} mail li.wei@example.cn`)
  appendRedactionHistory(masked, route)
  appendRedactionHistory(masked, route, Date.now() - DAY)
  appendRedactionHistory(diagnosticsFor("nothing here"), {
    client: "Codex",
    upstreams: [],
  })
  await flushRedactionHistory()

  const week = await summarizeRedactionHistory(7)
  expect(week.days).toHaveLength(7)
  expect(week.days.at(-1)).toMatchObject({ requests: 2, total: 2 })
  expect(week.days.at(-2)).toMatchObject({ requests: 1, total: 2 })
  expect(week.requests).toBe(3)
  expect(week.total).toBe(4)
  expect(week.byKind).toMatchObject({ SECRET: 2, PERSONAL: 2 })
  expect(week.byLabel).toMatchObject({ API_KEY: 2, EMAIL: 2 })
  expect(week.clients).toEqual([
    { name: "Claude Code", requests: 2, total: 4 },
    { name: "Codex", requests: 1, total: 0 },
  ])
  expect(week.upstreams[0]).toEqual({
    id: "conn-1",
    name: "Copilot",
    requests: 2,
    total: 4,
  })
  expect((await summarizeRedactionHistory(1)).requests).toBe(2)

  const files = await fs.readdir(PATHS.REDACTION_DIR)
  expect(files).toHaveLength(2)
  for (const file of files) {
    const text = await fs.readFile(path.join(PATHS.REDACTION_DIR, file), "utf8")
    expect(text).not.toContain(KEY)
    expect(text).not.toContain("li.wei")
    expect(text).not.toContain("{{")
  }
})

test("a half-written line is skipped", async () => {
  appendRedactionHistory(diagnosticsFor(KEY), {
    client: "Cline",
    upstreams: [],
  })
  await flushRedactionHistory()
  const [file] = await fs.readdir(PATHS.REDACTION_DIR)
  await fs.appendFile(path.join(PATHS.REDACTION_DIR, file), '{"t":1,"cli')
  expect((await summarizeRedactionHistory(1)).requests).toBe(1)
})
