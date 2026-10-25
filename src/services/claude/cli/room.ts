/**
 * 这台机器同时最多跑多少个 Claude Code 进程。
 *
 * 每个 run 是一个完整的 Claude Code 进程，自身约 100 MiB（共享的二进制页不算）。
 * 只按 connection 封顶时，N 个账号 × 每账号上限 + 空闲保留的 run 加起来可以
 * 远超机器内存：magpie 记录过 512 MiB 的 systemd 服务同时起了 16 个，被内核
 * OOM killer 一起杀掉（magpie #2956）。所以再加一层全机上限。
 */

import fs from "node:fs"
import os from "node:os"

const MIB = 1024 * 1024
/** 留给本进程和系统的余量。 */
const RESERVED_BYTES = 256 * MIB
/** 每个 Claude Code 进程按这么多算。 */
const PER_PROCESS_BYTES = 128 * MIB

let cached: number | undefined

/** 全机上限：`COPILOT_API_CLAUDE_MAX_PROCESSES`，否则按内存算，至少 1。 */
export function maxClaudeProcesses(): number {
  const raw = process.env.COPILOT_API_CLAUDE_MAX_PROCESSES?.trim()
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  cached ??= processesFor(memoryLimitBytes())
  return cached
}

/** 512 MiB → 2，1 GiB → 6，16 GiB → 126。 */
export function processesFor(limitBytes: number): number {
  return Math.max(
    1,
    Math.floor((limitBytes - RESERVED_BYTES) / PER_PROCESS_BYTES),
  )
}

/**
 * 本进程实际能用的内存：物理内存，与 Linux 上本进程所在 cgroup 及其每一层
 * 父 cgroup 的 v2 `memory.max` / `memory.high`、v1 `memory.limit_in_bytes`
 * 取最小。容器里 `os.totalmem()` 报的是宿主机内存，只看它会起太多。
 */
export function memoryLimitBytes(): number {
  let limit = os.totalmem()
  if (process.platform !== "linux") return limit
  for (const value of cgroupLimits()) limit = Math.min(limit, value)
  return limit
}

function cgroupLimits(): Array<number> {
  const limits: Array<number> = []
  const read = (file: string) => {
    try {
      const text = fs.readFileSync(file, "utf8").trim()
      const value = Number(text)
      // "max" 与 v1 的"无限"（接近 2^63）都不是限制。
      if (Number.isFinite(value) && value > 0 && value < 2 ** 60)
        limits.push(value)
    } catch {
      /* 没有这个文件：不是这种 cgroup。 */
    }
  }
  let membership = ""
  try {
    membership = fs.readFileSync("/proc/self/cgroup", "utf8")
  } catch {
    return limits
  }
  const v2 = /^0::(.*)$/m.exec(membership)?.[1]
  if (v2 !== undefined) {
    const parts = v2.split("/").filter(Boolean)
    for (let depth = parts.length; depth >= 0; depth--) {
      const dir = ["/sys/fs/cgroup", ...parts.slice(0, depth)].join("/")
      read(`${dir}/memory.max`)
      read(`${dir}/memory.high`)
    }
  }
  read("/sys/fs/cgroup/memory/memory.limit_in_bytes")
  return limits
}
