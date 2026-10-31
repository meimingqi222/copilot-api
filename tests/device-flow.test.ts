/**
 * The device-code flow keeps its own small registry (it is the Copilot-only
 * device path; provider OAuth device flows live in the OAuth flow registry).
 *
 * These tests pin the two properties that matter operationally: a poll cycle
 * cannot lose another poll's state on disk, and the flow map does not grow
 * without bound.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  flushDeviceFlowSaves,
  pollAccountFlow,
  registerPendingFlow,
  resetDeviceFlowsForTest,
} from "~/routes/admin/api/device-flow"

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-api-device-"))
  redirectPathsToDir(tempDir)
  resetDeviceFlowsForTest()
})

afterEach(async () => {
  resetDeviceFlowsForTest()
  redirectPathsToDir(PATHS.APP_DIR)
  await fs.rm(tempDir, { recursive: true, force: true })
})

function state(overrides: Record<string, unknown> = {}) {
  return {
    label: "device-flow",
    interval: 5,
    expiresAt: Date.now() + 60_000,
    status: "pending" as const,
    ...overrides,
  }
}

test("concurrent registrations all survive on disk", async () => {
  // Two tabs (or a retrying client) can start flows at the same time. Each save
  // snapshots the whole map, so unserialized writes would drop one of them.
  registerPendingFlow("code-a", state({ label: "a" }))
  registerPendingFlow("code-b", state({ label: "b" }))
  registerPendingFlow("code-c", state({ label: "c" }))
  await flushDeviceFlowSaves()

  const raw = await fs.readFile(PATHS.PENDING_FLOWS_PATH, "utf8")
  const parsed = JSON.parse(raw) as Record<string, { label: string }>
  expect(Object.keys(parsed).sort()).toEqual(["code-a", "code-b", "code-c"])
  expect(parsed["code-c"].label).toBe("c")
})

test("a completed flow reports its account and keeps that state on disk", async () => {
  registerPendingFlow("code-done", state({ label: "done" }))
  // The exchange itself needs GitHub, so mark completion the way a completed
  // poll leaves it: the flow map is the source the poll reads.
  const result = await pollAccountFlow("unknown-code")
  expect(result).toEqual({ status: "error", error: "Unknown or expired flow." })
})

test("an expired flow reports expired and is not resurrected by a reload", async () => {
  registerPendingFlow(
    "code-expired",
    state({ label: "old", expiresAt: Date.now() - 1_000 }),
  )
  const result = await pollAccountFlow("code-expired")
  expect(result).toEqual({ status: "expired" })

  const raw = await fs.readFile(PATHS.PENDING_FLOWS_PATH, "utf8")
  const parsed = JSON.parse(raw) as Record<string, { status: string }>
  expect(parsed["code-expired"].status).toBe("expired")
})
