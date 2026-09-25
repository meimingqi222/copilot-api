/**
 * Claude Code 二进制发现与版本探测。
 *
 * v2（CLI 传输层）需要一个真实安装的 `claude`。本模块只负责"找到它"和
 * "读出它的版本号"，不负责启动 —— 启动见 `./bridge`。
 *
 * 版本号在 CLI 路径上取代了 v1 `fingerprint.ts` 里硬编码的
 * `claudeCodeVersion`：本机 CLI 的版本才是权威的，硬编码会随上游发版漂移。
 * v1 的常量保持原样不动（见 `docs/todo-claude-cli-transport.md` §2.4）。
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"

/** 版本号缓存 TTL：10 分钟（照 magpie 的 `claudeClaimedVersion`）。 */
const VERSION_TTL_MS = 10 * 60_000
/** 探测版本的超时；CLI 冷启动可能慢，但不该拖住请求路径。 */
const VERSION_TIMEOUT_MS = 5_000

/** 从 `claude --version` 的输出里抠出版本号。 */
const SEMVER_RE = /\d+\.\d+\.\d+/

/** PATH 之外的候选目录，按顺序尝试。 */
const EXTRA_DIRS = ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"]

/** Windows 上 npm 装的 CLI 是 `.cmd`，直接 spawn 会失败。 */
const WINDOWS_EXTENSIONS = [".cmd", ".exe", ".bat", ""] as const
const POSIX_EXTENSIONS = [""] as const

let cachedVersion: string | undefined
let cachedVersionAt = 0

interface ClaudeCliTestHooks {
  /** 替换二进制查找（测试用；避免真的去扫 PATH）。 */
  findBinary?: () => string | undefined
  /** 替换版本探测（测试用；避免真的去执行二进制）。 */
  probeVersion?: (binary: string) => string | undefined
}

let testHooks: ClaudeCliTestHooks = {}

/**
 * 测试用注入点。传 `{}` 复位。
 *
 * 之所以不做成"在临时目录放个假脚本再改 PATH"：本仓库同时跑在 Windows 上，
 * 假脚本的可执行性依赖平台，测试会变得不可移植。
 */
export function setClaudeCliTestHooks(hooks: ClaudeCliTestHooks): void {
  testHooks = hooks
  cachedVersion = undefined
  cachedVersionAt = 0
}

/** 从 CLI 的版本输出里解析出 `x.y.z`；解析不出来返回 undefined。 */
export function parseClaudeVersion(raw: string): string | undefined {
  const match = SEMVER_RE.exec(raw)
  return match ? match[0] : undefined
}

function executableExtensions(): ReadonlyArray<string> {
  return process.platform === "win32" ? WINDOWS_EXTENSIONS : POSIX_EXTENSIONS
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function searchDirs(): Array<string> {
  const dirs: Array<string> = []
  const fromPath = process.env.PATH?.split(path.delimiter) ?? []
  for (const dir of fromPath) {
    if (dir) dirs.push(dir)
  }
  for (const raw of EXTRA_DIRS) {
    const expanded =
      raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw
    dirs.push(expanded)
  }
  return dirs
}

function findClaudeBinaryOnDisk(): string | undefined {
  const extensions = executableExtensions()
  for (const dir of searchDirs()) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `claude${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 找到本机的 `claude` 可执行文件；找不到返回 undefined。
 *
 * 返回 undefined 是**正常情况**（用户没装 CLI），调用方据此回落到 v1，
 * 不要把它当成错误。
 */
export function findClaudeBinary(): string | undefined {
  // 不能用 `?.() ?? ...`：hook 返回 undefined（"这台机器没装"）会被
  // `??` 当成"没有 hook"，转而真去扫磁盘 —— 测试就失去隔离了。
  if (testHooks.findBinary) return testHooks.findBinary()
  return findClaudeBinaryOnDisk()
}

function defaultProbeVersion(binary: string): string | undefined {
  try {
    const raw = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      // Windows 上 npm 装的 CLI 是 `.cmd`，必须经 shell 才能执行。
      shell: process.platform === "win32",
    })
    return parseClaudeVersion(raw)
  } catch {
    return undefined
  }
}

/**
 * 本机 `claude` 的版本号，带 10 分钟缓存；读不出来返回 undefined。
 *
 * 探测失败**不抛错**：版本号只用于观测与日志，不该让一次请求失败。
 */
export function claudeVersion(): string | undefined {
  const now = Date.now()
  if (cachedVersion !== undefined && now - cachedVersionAt < VERSION_TTL_MS) {
    return cachedVersion
  }
  const binary = findClaudeBinary()
  if (!binary) {
    cachedVersion = undefined
    cachedVersionAt = now
    return undefined
  }
  const probe = testHooks.probeVersion ?? defaultProbeVersion
  cachedVersion = probe(binary)
  cachedVersionAt = now
  return cachedVersion
}

/**
 * 每个 connection 一个**持久**的 Claude Code 工作目录。
 *
 * 必须是持久的，不能用 `mkdtemp`：Claude Code 的 system prompt 里带
 * working directory，每回合换一个随机目录会让 token 流的第一个 token 就变，
 * Anthropic 的前缀 prompt cache 于是每回合全量 miss。
 * 参考 magpie 的 `cursorHome()`（`internal/gateway/cursor_subscription.go:167`）。
 */
export function claudeHome(connectionId: string): string {
  return path.join(PATHS.CACHE_DIR, "claude-home", safeSegment(connectionId))
}

/**
 * 传给子进程的 `CLAUDE_CONFIG_DIR` —— Claude Code 的**配置与会话根**。
 *
 * 为什么必须设置（隐私）：
 *
 * Claude Code 把**完整对话正文**写进 `<configDir>/projects/<cwd-slug>/*.jsonl`。
 * 不设置时那是用户的 `~/.claude/projects/`；而 `claudeHome` 是持久目录，
 * 于是一个固定的 cwd slug 会把**所有**对话的转录永久累积在用户真实的
 * Claude 数据目录里（magpie 用一次性 temp cwd 恰好避开了这点）。
 *
 * 指向我们自己的数据目录后：
 *
 * 1. 用户 `~/.claude` 不再被写任何东西；
 * 2. 整个目录归我们所有，可以自由做保留期清理（见 `./transcripts`）。
 *
 * 已实测确认：设置它不影响 `CLAUDE_CODE_OAUTH_TOKEN` 认证路径，
 * 且转录确实落在该目录下。
 */
export function claudeConfigDir(connectionId: string): string {
  return path.join(claudeHome(connectionId), ".claude")
}

/** 把 connection id 变成安全的单层路径分量。 */
function safeSegment(connectionId: string): string {
  return (
    connectionId
      .replaceAll(/[^a-zA-Z0-9._-]/g, "_")
      // 去掉前导点：`..` 本身是父目录，且 `..foo` 这类名字只添麻烦。
      .replace(/^\.+/, "") || "default"
  )
}
