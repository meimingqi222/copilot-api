/**
 * Antigravity 传输方式选择：`"acp"`（驱动官方 `agy acp`）或 `"http"`（直连重放）。
 *
 * 优先级：
 * 1. `COPILOT_API_ANTIGRAVITY_TRANSPORT` 环境变量（`"http"` | `"acp"`）
 * 2. `connection.metadata.antigravityTransport`（`"http"` | `"acp"`）
 * 3. 默认：若本机可找到 `agy` 二进制则走 `"acp"`，否则回退 `"http"`（显式指定 `"acp"` 时找不到则报错）
 */

import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"

export type AntigravityTransport = "acp" | "http"

const METADATA_KEY = "antigravityTransport"

function parseTransport(value: unknown): AntigravityTransport | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "acp" || normalized === "http") {
    return normalized
  }
  return undefined
}

/** 查找本机 `agy` 可执行文件路径。 */
export function findAgyBinary(): string | undefined {
  const fromEnv = process.env.AGY_CLI_PATH?.trim()
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }

  const resolved = Bun.which("agy")
  if (resolved) return resolved

  const localBin = path.join(os.homedir(), ".local", "bin", "agy")
  if (existsSync(localBin)) {
    return localBin
  }
  return undefined
}

export function resolveAntigravityTransport(
  connection: ProviderConnection,
): AntigravityTransport {
  const envTransport = parseTransport(
    process.env.COPILOT_API_ANTIGRAVITY_TRANSPORT,
  )
  if (envTransport === "http") return "http"

  const metaTransport = parseTransport(connection.metadata?.[METADATA_KEY])
  if (envTransport === undefined && metaTransport === "http") {
    return "http"
  }

  const binary = findAgyBinary()
  if (!binary) {
    if (envTransport === "acp" || metaTransport === "acp") {
      throw new Error(
        "Antigravity ACP transport is selected but no `agy` binary was found. "
          + "Install Antigravity CLI (`agy`) or set antigravityTransport to `http`.",
      )
    }
    return "http"
  }

  return "acp"
}
