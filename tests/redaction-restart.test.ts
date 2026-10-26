import { expect, test } from "bun:test"
import path from "node:path"

function runProcess(...args: Array<string>): string {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/redaction-restart.ts", ...args],
    { cwd: path.resolve(import.meta.dir, "..") },
  )
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

test("ordinary placeholders survive a real process restart without restoring another caller's values", () => {
  const oldInput = runProcess("mask")
  const input = JSON.parse(oldInput) as { password: string; text: string }
  expect(input.password).toStartWith("{{SECRET_")
  expect(input.text).toContain("{{HOME_")
  expect(input.text).toContain("{{WORD_")
  const replay = JSON.parse(runProcess("replay", oldInput)) as {
    masked: typeof input
    restored: typeof input
    streamed: Array<{ delta: string }>
    tool: { arguments: string }
  }
  expect(JSON.parse(replay.tool.arguments)).toEqual({ command: input.text })
  expect(replay.masked).toEqual(input)
  expect(replay.restored).toEqual(input)
  expect(replay.streamed.map((frame) => frame.delta).join("")).toBe(input.text)
})
