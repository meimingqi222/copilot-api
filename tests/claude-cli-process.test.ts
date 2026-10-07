import { expect, test } from "bun:test"
import { terminateClaudeProcess } from "~/services/claude/cli/process"
import { installFakeClaude } from "./claude-cli-fixtures"
import { testConnection, testCredential } from "./claude-cli-fixtures"
import { ClaudeCliRun } from "~/services/claude/cli/bridge"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("retains MCP configuration until the CLI process exits", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-cleanup-test-"),
  )
  const config = path.join(tmpDir, "mcp.json")
  await fs.writeFile(config, "{}")
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    exit = resolve
  })
  const proc = {
    exitCode: 0,
    exited,
    stdin: { end() {} },
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
  } as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">
  const run = new ClaudeCliRun({
    token: "cleanup-test",
    payload: { model: "test-model", max_tokens: 100, messages: [] },
    context: {
      connection: testConnection(),
      credential: testCredential(),
      model: "test-model",
      accessToken: "fake",
    },
    proc,
    tmpDir,
  })
  try {
    run.abort()
    await Bun.sleep(30)
    expect(await Bun.file(config).exists()).toBe(true)
    exit(0)
    const deadline = Date.now() + 1000
    while ((await Bun.file(config).exists()) && Date.now() < deadline)
      await Bun.sleep(10)
    expect(await Bun.file(config).exists()).toBe(false)
  } finally {
    exit(0)
    run.abort()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("terminates the launcher and its live CLI child", async () => {
  const proc = Bun.spawn([await installFakeClaude()], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: "process-hang" },
  })
  proc.stdin.write('{"type":"user","message":{"content":[]}}\n')
  proc.stdin.flush()
  const reader = proc.stdout.getReader()
  let childPid = 0
  try {
    const decoder = new TextDecoder()
    let buffer = ""
    while (!childPid) {
      const next = await reader.read()
      if (next.done)
        throw new Error("launcher exited before reporting its child")
      buffer += decoder.decode(next.value, { stream: true })
      const complete = buffer.split("\n")
      buffer = complete.pop() ?? ""
      for (const line of complete) {
        const envelope = JSON.parse(line) as {
          event?: { delta?: { text?: string } }
        }
        if (envelope.event?.delta?.text)
          childPid = (JSON.parse(envelope.event.delta.text) as { pid: number })
            .pid
      }
    }
    expect(childPid).toBeGreaterThan(0)
    terminateClaudeProcess(proc)
    await proc.exited
    if (process.platform === "win32") {
      const deadline = Date.now() + 3000
      let live = true
      while (live && Date.now() < deadline) {
        try {
          process.kill(childPid, 0)
          await Bun.sleep(20)
        } catch {
          live = false
        }
      }
      expect(live).toBe(false)
    }
  } finally {
    reader.releaseLock()
    terminateClaudeProcess(proc)
    if (childPid) {
      try {
        process.kill(childPid)
      } catch {
        /* Already terminated. */
      }
    }
  }
})
