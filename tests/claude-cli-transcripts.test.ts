import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  claudeTranscriptTtlDays,
  pruneClaudeTranscripts,
  resetClaudeTranscriptPruneForTest,
} from "~/services/claude/cli/transcripts"

const DAY_MS = 24 * 60 * 60_000

let configDir: string

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-transcripts-"))
  resetClaudeTranscriptPruneForTest()
  delete process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS
})

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true })
  delete process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS
})

/** Write a transcript file with an explicit age in days. */
async function writeTranscript(
  slug: string,
  name: string,
  ageDays: number,
): Promise<string> {
  const dir = path.join(configDir, "projects", slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, '{"type":"user"}\n', "utf8")
  const when = new Date(Date.now() - ageDays * DAY_MS)
  await fs.utimes(file, when, when)
  return file
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

describe("claudeTranscriptTtlDays", () => {
  test("defaults to 7 days", () => {
    expect(claudeTranscriptTtlDays()).toBe(7)
  })

  test("honours the environment override", () => {
    process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS = "30"
    expect(claudeTranscriptTtlDays()).toBe(30)
  })

  test("falls back on a garbage value", () => {
    process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS = "soon"
    expect(claudeTranscriptTtlDays()).toBe(7)
  })
})

describe("pruneClaudeTranscripts", () => {
  test("deletes transcripts past the retention window", async () => {
    const old = await writeTranscript("slug-a", "old.jsonl", 30)
    const fresh = await writeTranscript("slug-a", "fresh.jsonl", 1)
    expect(await pruneClaudeTranscripts(configDir)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })

  test("sweeps every project directory, not just the first", async () => {
    const a = await writeTranscript("slug-a", "a.jsonl", 30)
    const b = await writeTranscript("slug-b", "b.jsonl", 30)
    expect(await pruneClaudeTranscripts(configDir)).toBe(2)
    expect(await exists(a)).toBe(false)
    expect(await exists(b)).toBe(false)
  })

  test("keeps files that are not transcripts", async () => {
    const dir = path.join(configDir, "projects", "slug-a")
    await fs.mkdir(dir, { recursive: true })
    const other = path.join(dir, "notes.md")
    await fs.writeFile(other, "keep me", "utf8")
    const when = new Date(Date.now() - 90 * DAY_MS)
    await fs.utimes(other, when, when)
    expect(await pruneClaudeTranscripts(configDir)).toBe(0)
    expect(await exists(other)).toBe(true)
  })

  test("a ttl of 0 disables pruning entirely", async () => {
    process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS = "0"
    const old = await writeTranscript("slug-a", "old.jsonl", 365)
    expect(await pruneClaudeTranscripts(configDir)).toBe(0)
    expect(await exists(old)).toBe(true)
  })

  test("is a no-op when the projects directory does not exist", async () => {
    expect(await pruneClaudeTranscripts(configDir)).toBe(0)
  })

  test("does not throw on a missing config dir", async () => {
    const missing = path.join(configDir, "nope", "deeper")
    expect(await pruneClaudeTranscripts(missing)).toBe(0)
  })

  /**
   * Pruning runs on the request path (best effort, at most hourly). It must not
   * scan the tree once per turn.
   */
  test("throttles to one sweep per interval", async () => {
    const first = await writeTranscript("slug-a", "first.jsonl", 30)
    expect(await pruneClaudeTranscripts(configDir)).toBe(1)
    const second = await writeTranscript("slug-a", "second.jsonl", 30)
    // Second call within the interval: skipped, so the new file survives.
    expect(await pruneClaudeTranscripts(configDir)).toBe(0)
    expect(await exists(second)).toBe(true)
    expect(await exists(first)).toBe(false)
    // After an explicit reset it sweeps again.
    resetClaudeTranscriptPruneForTest()
    expect(await pruneClaudeTranscripts(configDir)).toBe(1)
  })
})
