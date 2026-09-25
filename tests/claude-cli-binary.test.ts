import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"

import {
  claudeHome,
  claudeVersion,
  findClaudeBinary,
  parseClaudeVersion,
  setClaudeCliTestHooks,
} from "~/services/claude/cli/binary"

afterEach(() => {
  setClaudeCliTestHooks({})
})

describe("parseClaudeVersion", () => {
  test("reads a bare version", () => {
    expect(parseClaudeVersion("2.1.280")).toBe("2.1.280")
  })

  test("reads a version out of noisy output", () => {
    expect(parseClaudeVersion("claude 2.1.280 (Claude Code)\n")).toBe("2.1.280")
  })

  test("takes the first semver when several appear", () => {
    expect(parseClaudeVersion("node v22.13.0, claude 2.1.280")).toBe("22.13.0")
  })

  test("returns undefined when there is no version", () => {
    expect(parseClaudeVersion("command not found")).toBeUndefined()
    expect(parseClaudeVersion("")).toBeUndefined()
  })
})

describe("findClaudeBinary", () => {
  test("returns undefined when nothing is installed", () => {
    setClaudeCliTestHooks({ findBinary: () => undefined })
    expect(findClaudeBinary()).toBeUndefined()
  })

  test("returns the discovered path", () => {
    setClaudeCliTestHooks({ findBinary: () => "/opt/homebrew/bin/claude" })
    expect(findClaudeBinary()).toBe("/opt/homebrew/bin/claude")
  })
})

describe("claudeVersion", () => {
  test("returns undefined when no binary is installed", () => {
    setClaudeCliTestHooks({ findBinary: () => undefined })
    expect(claudeVersion()).toBeUndefined()
  })

  test("probes the binary once and caches the result", () => {
    let probes = 0
    setClaudeCliTestHooks({
      findBinary: () => "/usr/local/bin/claude",
      probeVersion: () => {
        probes += 1
        return "2.1.280"
      },
    })
    expect(claudeVersion()).toBe("2.1.280")
    expect(claudeVersion()).toBe("2.1.280")
    expect(probes).toBe(1)
  })

  test("a failed probe does not throw and does not cache a version", () => {
    setClaudeCliTestHooks({
      findBinary: () => "/usr/local/bin/claude",
      probeVersion: () => undefined,
    })
    expect(claudeVersion()).toBeUndefined()
  })

  test("setting hooks clears the cache", () => {
    setClaudeCliTestHooks({
      findBinary: () => "/usr/local/bin/claude",
      probeVersion: () => "2.1.280",
    })
    expect(claudeVersion()).toBe("2.1.280")
    setClaudeCliTestHooks({
      findBinary: () => "/usr/local/bin/claude",
      probeVersion: () => "2.2.0",
    })
    expect(claudeVersion()).toBe("2.2.0")
  })
})

describe("claudeHome", () => {
  test("is stable for one connection", () => {
    expect(claudeHome("conn-1")).toBe(claudeHome("conn-1"))
  })

  test("differs between connections", () => {
    expect(claudeHome("conn-1")).not.toBe(claudeHome("conn-2"))
  })

  test("sanitizes path-hostile ids", () => {
    // 真正的安全属性：结果永远只是 claude-home 下的一个路径分量。
    for (const hostile of ["../../etc/passwd", "a/b\\c", "..", ".", ""]) {
      const resolved = path.resolve(claudeHome(hostile))
      const root = path.resolve(path.dirname(claudeHome("x")))
      expect(path.dirname(resolved)).toBe(root)
      expect(path.basename(resolved)).not.toBe("..")
      expect(path.basename(resolved)).not.toBe(".")
      expect(path.basename(resolved)).not.toBe("")
    }
  })
})
