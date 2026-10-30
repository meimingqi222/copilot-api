/**
 * ZCode 官方客户端里的 API 端点清单扫描。
 *
 * 上游换接口时，唯一可靠的信息源是客户端自己（Electron 的 `app.asar`）。
 * 这里做两件小事：
 *
 *   1. 从任意字节流里抽出 `/api/v1/...` 端点（分块，避免把 340MB 全读进内存）；
 *   2. 与仓库里的快照做 diff，列出「新增」和「消失」的端点。
 *
 * 只关心会变的那几个前缀（套餐投放、营销、版本、配置），其余业务端点
 * 噪声太大，不进快照。脚本入口见 `scripts/live/zcode-probe.ts`。
 */

import fs from "node:fs"

/** 会随上游改版而搬迁的端点前缀；其余 /api/v1 路径不进快照。 */
const TRACKED_PREFIXES = [
  "/api/v1/zcode-plan",
  "/api/v1/marketing",
  "/api/v1/releases",
  "/api/v1/client/configs",
  "/api/v1/oauth",
] as const

/** 分块扫描时的重叠长度：端点最长也就几十字节，128 足够跨块。 */
const CHUNK_OVERLAP = 128

const API_PATH_RE = /\/api\/v1\/[A-Za-z0-9._~/-]+/g

/** 去掉尾部的分隔符/垃圾字符，并丢掉明显不是端点的片段。 */
function normalizeApiPath(raw: string): string | undefined {
  const trimmed = raw.replace(/[/.,;:'")\]}]+$/, "")
  if (!trimmed.startsWith("/api/v1/")) return undefined
  if (trimmed.includes("..")) return undefined
  if (trimmed.length > 96) return undefined
  return trimmed
}

/** 是否属于会搬迁的那几类端点。 */
export function isTrackedZcodePath(path: string): boolean {
  return TRACKED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}

/**
 * 增量扫描器：`push` 任意分块，`finish` 给出全部端点。
 *
 * 分块之间保留一段重叠，端点跨越块边界也不会被切断。
 */
export function createZcodeApiPathScanner(): {
  push: (chunk: Uint8Array) => void
  finish: () => Array<string>
} {
  const found = new Set<string>()
  let carry = ""

  const harvest = (text: string, flush: boolean) => {
    for (const match of text.matchAll(API_PATH_RE)) {
      const path = normalizeApiPath(match[0])
      // 末尾可能还连着下一段路径，只有 flush 时才能确定它结束了。
      if (!path) continue
      if (!flush && match.index + match[0].length >= text.length) continue
      found.add(path)
    }
  }

  return {
    push(chunk) {
      const text = carry + Buffer.from(chunk).toString("latin1")
      harvest(text, false)
      carry = text.slice(-CHUNK_OVERLAP)
    },
    finish() {
      harvest(carry, true)
      carry = ""
      return [...found].sort()
    },
  }
}

/** 一次性扫描整块 buffer（测试和小文件用）。 */
export function extractZcodeApiPaths(buffer: Uint8Array): Array<string> {
  const scanner = createZcodeApiPathScanner()
  scanner.push(buffer)
  return scanner.finish()
}

/** 分块扫描一个文件（app.asar 这种几百 MB 的二进制）。 */
export function scanZcodeApiPathsInFile(
  filePath: string,
  chunkBytes = 8 * 1024 * 1024,
): Array<string> {
  const scanner = createZcodeApiPathScanner()
  const buffer = Buffer.alloc(chunkBytes)
  const fd = fs.openSync(filePath, "r")
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, chunkBytes, null)
      if (read <= 0) break
      scanner.push(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return scanner.finish()
}

interface EndpointDiff {
  /** 客户端有、快照里没有：可能是新接口。 */
  added: Array<string>
  /** 快照里有、客户端没有：我们可能还在用一个已废弃的接口。 */
  missing: Array<string>
}

/** 比较快照与实际扫描结果，只比较被跟踪的前缀。 */
export function diffZcodeEndpoints(
  snapshot: ReadonlyArray<string>,
  found: ReadonlyArray<string>,
): EndpointDiff {
  const expected = new Set(snapshot.filter(isTrackedZcodePath))
  const actual = new Set(found.filter(isTrackedZcodePath))
  return {
    added: [...actual].filter((path) => !expected.has(path)).sort(),
    missing: [...expected].filter((path) => !actual.has(path)).sort(),
  }
}
