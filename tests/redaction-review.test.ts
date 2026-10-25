import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  RedactionScope,
  runRedactedCall,
  withRedactionUpstream,
} from "~/lib/redaction/context"
import {
  beginRedactionInspection,
  captureRedactionAttempt,
  captureRedactionHttp,
  clearRedactionInspection,
  emptyRedactionDiagnostics,
  finishRedactionInspection,
  getRedactionDiagnostics,
  getRedactionInspection,
  getRedactionInspectionState,
  recordRedactionDiagnostics,
  setRedactionInspection,
} from "~/lib/redaction/diagnostics"
import { flushRedactionHistory } from "~/lib/redaction/history"
import { PATHS } from "~/lib/paths"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { initializeSystemConfig } from "~/lib/system-config"
import {
  performanceFetch,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"

const upstream = {
  id: "review-fixture",
  name: "Fixture",
  protocol: "openai-compatible",
  model: "fixture",
}
const home = ["C:", "Users", "Fixture Person"].join("\\")

afterEach(() => {
  setRedactionInspection(false)
  delete process.env.UPSTREAM_REDACTION
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("spaced home names are masked completely in plain text, shell arguments and JSON tool output", () => {
  for (const prefix of [
    home,
    home.replaceAll("\\", "/"),
    ["", "Users", "Fixture Person"].join("/"),
    ["", "home", "fixture person"].join("/"),
  ]) {
    for (const text of [
      `Read ${prefix}/project`,
      `Get-Content '${prefix}/.codex/config.toml'`,
      JSON.stringify({ path: `${prefix}/project` }),
    ]) {
      const scope = new RedactionScope(
        redactionConfigSchema.parse({ enabled: true }),
      )
      const masked = scope.maskText(text)
      expect(masked).not.toContain("Person")
      expect(masked).not.toContain("person")
      expect(scope.restoreText(masked)).toBe(text)
    }
  }
})

test("inspection policy defaults to continuous masked evidence and never retains raw client input", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  expect(setRedactionInspection(true).expiresAt).toBeNull()
  await runRedactedCall({ input: `${home}/project` }, undefined, (prepared) =>
    withRedactionUpstream(upstream, prepared, async () => ({
      response: { text: "ok" },
    })),
  )
  const entry = getRedactionDiagnostics().entries[0]
  const detail = getRedactionInspection(entry.id, true)!
  expect(detail.input).toBeNull()
  expect(detail.mappings).toHaveLength(1)
  expect("value" in detail.mappings[0] && detail.mappings[0].value).toBe(home)
  expect(detail.version).toBeGreaterThan(0)
  expect(entry.contentVersion).toBe(detail.version)
  clearRedactionInspection()
  expect(getRedactionDiagnostics().entries[0].contentState).toBe("cleared")
  expect(getRedactionInspectionState().bytes).toBe(0)
})

test("detected values distinguish replaced, warned and blocked actions without double counting mask passes", () => {
  const scope = new RedactionScope(
    redactionConfigSchema.parse({
      enabled: true,
      words: ["fixture-word"],
      actions: { HOME: "warn", WORD: "mask" },
    }),
  )
  for (let i = 0; i < 3; i++)
    scope.maskText(`${home}/p fixture-word fixture-word`)
  expect(scope.diagnostics()).toMatchObject({
    detected: 2,
    total: 1,
    warned: 1,
    detectedByKind: { HOME: 1, WORD: 1 },
    warnedByKind: { HOME: 1 },
  })
  const blocked = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, actions: { HOME: "block" } }),
  )
  expect(() => blocked.maskText(home + "/p")).toThrow()
  expect(blocked.diagnostics()).toMatchObject({
    detected: 1,
    total: 0,
    blockedCount: 1,
    blockedByKind: { HOME: 1 },
  })
})

test("HTTP placeholder positions and repeated adapter attempts remain observable with content capture disabled", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  setRedactionInspection(false)
  const mockFetch = Object.assign(async () => Response.json({ ok: true }), {
    preconnect: globalThis.fetch.preconnect,
  })
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mockFetch)
  try {
    await runRedactedCall(
      { input: `${home}/a ${home}/b` },
      undefined,
      async (prepared) => {
        for (let i = 0; i < 2; i++)
          await withRedactionUpstream(upstream, prepared, async () => {
            serializeUpstreamBody(prepared)
            serializeUpstreamBody(prepared)
            await performanceFetch("http://fixture.invalid", {
              method: "POST",
              body: serializeUpstreamBody(prepared),
            })
          })
        return { response: { text: "done" } }
      },
    )
    const entry = getRedactionDiagnostics().entries[0]
    expect(entry.total).toBe(1)
    expect(entry.attempts).toHaveLength(2)
    expect(
      entry.attempts.map((attempt) =>
        attempt.bodies.map((body) => body.places),
      ),
    ).toEqual([[2], [2]])
    expect(entry.attempts.map((attempt) => attempt.bodies[0].status)).toEqual([
      "response",
      "response",
    ])
    expect(entry.contentAvailable).toBe(false)
    expect(entry.contentState).toBe("not_collected")
  } finally {
    fetchMock.mockRestore()
  }
})

test("history uses request start time even when completion crosses a day boundary", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  const started = Date.now() - 86400000
  const clock = spyOn(Date, "now").mockReturnValue(started)
  let id = 0
  try {
    await runRedactedCall({ input: "nothing" }, undefined, async () => {
      id = getRedactionDiagnostics().entries[0].id
      clock.mockReturnValue(started + 86400000)
      return { response: { text: "ok" } }
    })
  } finally {
    clock.mockRestore()
  }
  await flushRedactionHistory()
  const entry = getRedactionDiagnostics().entries.find(
    (item) => item.id === id,
  )!
  expect(entry.timestamp).toBe(started)
  const date = new Date(started)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  const lines = (
    await fs.readFile(path.join(PATHS.REDACTION_DIR, day + ".jsonl"), "utf8")
  )
    .trim()
    .split("\n")
  expect(lines.some((line) => JSON.parse(line).t === started)).toBe(true)
})

test("multiple large attempts retain hit evidence and bounded mapping values with exact byte accounting", () => {
  setRedactionInspection(true)
  const capture = beginRedactionInspection("must not retain raw input")!
  const token = "{{WORD_abcdefgh}}"
  const payload = "x".repeat(50_000) + token
  for (let i = 0; i < 8; i++) {
    const index = captureRedactionAttempt(capture, upstream, { input: payload })
    captureRedactionHttp(capture, index, JSON.stringify({ input: payload }))
  }
  const mappings = [
    {
      placeholder: token,
      kind: "WORD" as const,
      label: "WORD" as const,
      source: "word" as const,
      value: "v".repeat(10_000),
    },
    {
      placeholder: "{{HOME_abcdefgh}}",
      kind: "HOME" as const,
      label: "HOME" as const,
      source: "builtin" as const,
      value: home,
    },
  ]
  finishRedactionInspection(capture, mappings)
  const id = recordRedactionDiagnostics(
    emptyRedactionDiagnostics(),
    { client: "Fixture", upstreams: [upstream] },
    capture,
    "in_progress",
  )
  const detail = getRedactionInspection(id, true)!
  expect(detail.attempts).toHaveLength(8)
  expect(
    detail.attempts.every((attempt) =>
      attempt.excerpts.some((item) => item.text.includes(token)),
    ),
  ).toBe(true)
  expect(detail.attempts.some((attempt) => attempt.body === "")).toBe(true)
  expect(detail.mappings).toHaveLength(2)
  expect(detail.mappings[0]).toMatchObject({
    truncated: true,
    originalLength: 10_000,
  })
  expect(detail.mappings[1]).toMatchObject({
    truncated: false,
    originalLength: home.length,
  })
  const retainedBytes =
    2
    * (detail.attempts.reduce(
      (sum, attempt) =>
        sum
        + Object.values(attempt.upstream).join("").length
        + attempt.stage.length
        + attempt.body.length
        + attempt.excerpts.reduce(
          (total, item) => total + item.path.length + item.text.length,
          0,
        ),
      0,
    )
      + detail.mappings.reduce(
        (sum, mapping) =>
          sum
          + mapping.placeholder.length
          + mapping.kind.length
          + mapping.label.length
          + mapping.source.length
          + ("value" in mapping ? mapping.value.length : 0),
        0,
      ))
  expect(getRedactionInspectionState().bytes).toBe(retainedBytes)
  expect(retainedBytes).toBeLessThanOrEqual(
    getRedactionInspectionState().maxEntryBytes,
  )
  finishRedactionInspection(capture, mappings)
  expect(getRedactionInspection(id, true)!.version).toBe(detail.version)
  expect(getRedactionInspectionState().bytes).toBe(retainedBytes)
  clearRedactionInspection()
  expect(getRedactionInspectionState().bytes).toBe(0)
})
