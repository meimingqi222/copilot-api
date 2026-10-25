#!/usr/bin/env node

import { defineCommand } from "citty"
import fs from "node:fs/promises"
import os from "node:os"

import path from "node:path"

import {
  buildDiagnosticBundle,
  bundleFileName,
  compressBundle,
} from "~/lib/diagnostics/bundle"
import { initLogger, logger } from "~/lib/logger"
import { upsertProviderConnection } from "~/lib/provider-connections"
import { loadProviderConnections } from "~/lib/provider-connections/store"
import { statsStore } from "~/lib/stats-store"
import { SYSTEM_CONFIG_KEY, initializeSystemConfig } from "~/lib/system-config"

import { PATHS, ensurePaths } from "./lib/paths"

interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
    LOG_DIR: string
  }
  tokenExists: boolean
}

interface RunDebugOptions {
  json: boolean
  bundle?: boolean
  since?: string
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url).pathname
    // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
    // JSON.parse() can actually parse buffers
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath)) as {
      version: string
    }
    return packageJson.version
  } catch {
    return "unknown"
  }
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function checkTokenExists(): Promise<boolean> {
  try {
    const stats = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
    if (!stats.isFile()) return false

    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

async function getDebugInfo(): Promise<DebugInfo> {
  const [version, tokenExists] = await Promise.all([
    getPackageVersion(),
    checkTokenExists(),
  ])

  return {
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH,
      LOG_DIR: PATHS.LOG_DIR,
    },
    tokenExists,
  }
}

function printDebugInfoPlain(info: DebugInfo): void {
  logger.info(`copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}
- LOG_DIR: ${info.paths.LOG_DIR}

Token exists: ${info.tokenExists ? "Yes" : "No"}`)
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

/** "24h", "90m", "7d" in milliseconds; plain numbers are hours. */
function parseSince(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(value.trim())
  if (!match)
    throw new Error(`Invalid --since "${value}"; use e.g. 90m, 24h, 7d`)
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    (match[2] || "h").toLowerCase() as "m" | "h" | "d"
  ]
  return Number(match[1]) * unit
}

/**
 * The same bundle the admin page exports, read from disk: it works when the
 * server will not start. Settings come from the stats store when it opens,
 * else from the environment, as the server would fall back to.
 */
async function writeBundle(since: string): Promise<void> {
  const sinceMs = parseSince(since)
  try {
    statsStore.init()
    initializeSystemConfig({
      value: statsStore.getConfig(SYSTEM_CONFIG_KEY),
      save: () => {},
      onChange: () => {},
    })
  } catch (error) {
    logger.warn(
      "Could not read saved settings; using the environment's:",
      error,
    )
  }
  try {
    for (const connection of await loadProviderConnections())
      upsertProviderConnection(connection)
  } catch (error) {
    logger.warn("Could not read provider connections:", error)
  }
  const bundle = await buildDiagnosticBundle({ sinceMs })
  const file = path.resolve(bundleFileName())
  await fs.writeFile(file, new Uint8Array(compressBundle(bundle)))
  logger.success(
    `Wrote ${file} (${Object.entries(bundle.manifest.counts)
      .map(([name, count]) => `${count} ${name}`)
      .join(", ")}; ${bundle.manifest.redactions} values masked)`,
  )
}

async function runDebug(options: RunDebugOptions): Promise<void> {
  await ensurePaths()
  initLogger()
  if (options.bundle) return writeBundle(options.since ?? "24h")
  const debugInfo = await getDebugInfo()

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
    bundle: {
      type: "boolean",
      default: false,
      description:
        "Write a redacted diagnostic bundle (.json.gz) to the current directory",
    },
    since: {
      type: "string",
      default: "24h",
      description: "How far back the bundle's logs go (e.g. 90m, 24h, 7d)",
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
      bundle: args.bundle,
      since: args.since,
    })
  },
})
