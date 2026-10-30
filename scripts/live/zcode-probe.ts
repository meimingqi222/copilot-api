/**
 * ZCode 领取链路诊断（**不进 CI**，需要真实账号的会话 JWT）。
 *
 * 用法：
 *   bun run scripts/live/zcode-probe.ts                 # 第一个可用账号
 *   bun run scripts/live/zcode-probe.ts --account 71f2  # id 或名字的子串
 *   bun run scripts/live/zcode-probe.ts --asar <path>   # 顺带 diff 客户端端点清单
 *   bun run scripts/live/zcode-probe.ts --asar <path> --write-snapshot
 *
 * 回答的问题：上游现在把「可领套餐」放在哪个接口、我们的抽取器还能不能
 * 认出来、官方客户端是不是又多了/少了端点。JWT 只报长度，绝不打印。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  collectMarketingPlans,
  fetchZcodeClaimPlans,
  parseZcodeClaimPlans,
} from "~/services/zcode/claim"
import {
  zcodeBillingHeaders,
  zcodeSessionJwt,
} from "~/services/zcode/start-plan"
import {
  diffZcodeEndpoints,
  isTrackedZcodePath,
  scanZcodeApiPathsInFile,
} from "~/services/zcode/endpoint-scan"
import {
  resolveZcodeAppVersion,
  ZCODE_API,
  ZCODE_APP_VERSION,
} from "~/services/oauth/zcode"

const SNAPSHOT_PATH = path.join(
  import.meta.dir,
  "zcode-endpoints.snapshot.json",
)

interface SnapshotFile {
  clientVersion?: string
  capturedAt?: string
  endpoints: Array<string>
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : ""
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** 默认从当前用户目录里找 ZCode 客户端（找不到就跳过 asar diff）。 */
function defaultAsarPath(): string | undefined {
  if (process.platform !== "win32") return undefined
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "ZCode",
      "resources",
      "app.asar",
    ),
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Programs",
      "ZCode",
      "resources",
      "app.asar",
    ),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

function readZcodeConnections(): Array<ProviderConnection> {
  const file = PATHS.PROVIDER_CONNECTIONS_PATH
  if (!fs.existsSync(file)) {
    throw new Error(
      `No connections file at ${file} — run the server once first.`,
    )
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    connections?: Array<ProviderConnection>
  }
  return (parsed.connections ?? []).filter(
    (connection) => connection.metadata?.provider === "zcode",
  )
}

function pickAccount(
  connections: Array<ProviderConnection>,
  wanted: string | undefined,
): ProviderConnection | undefined {
  const withJwt = connections.filter((c) => zcodeSessionJwt(c))
  if (!wanted) return withJwt[0]
  return withJwt.find(
    (c) =>
      c.id === wanted || c.name.toLowerCase().includes(wanted.toLowerCase()),
  )
}

interface RawProbe {
  label: string
  path: string
  /** 抽取器；默认只打印 data 是否存在。 */
  extract?: (data: unknown) => Array<string>
}

function planIds(plans: Array<{ planId: string }>): Array<string> {
  return plans.map((plan) => plan.planId)
}

async function probeRaw(
  connection: ProviderConnection,
  probe: RawProbe,
  appVersion: string,
): Promise<void> {
  const url = `${ZCODE_API}${probe.path}`
  const response = await fetch(url, {
    headers: {
      ...zcodeBillingHeaders(appVersion),
      authorization: `Bearer ${zcodeSessionJwt(connection)}`,
    },
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = (JSON.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    body = {}
  }
  const hasData = "data" in body
  const envelope = `code=${String(body.code ?? "?")} msg=${JSON.stringify(body.msg ?? "")}`
  console.log(`  ${probe.label}`)
  console.log(
    `    HTTP ${response.status}  ${envelope}  data: ${hasData ? "yes" : "NO"}`,
  )
  if (hasData && probe.extract) {
    const ids = probe.extract(body.data)
    console.log(`    plans: ${ids.length ? ids.join(", ") : "(none)"}`)
  }
}

async function scanAsar(aspectPath: string | undefined): Promise<void> {
  const asarPath = aspectPath || defaultAsarPath()
  if (!asarPath) {
    console.log(
      "\n== client endpoints ==\n  skipped (no app.asar; pass --asar <path>)",
    )
    return
  }
  if (!fs.existsSync(asarPath)) {
    console.log(`\n== client endpoints ==\n  skipped (not found: ${asarPath})`)
    return
  }
  console.log(`\n== client endpoints ==\n  ${asarPath}`)
  const found = scanZcodeApiPathsInFile(asarPath).filter(isTrackedZcodePath)

  if (hasFlag("write-snapshot")) {
    const snapshot: SnapshotFile = {
      clientVersion: ZCODE_APP_VERSION,
      capturedAt: new Date().toISOString().slice(0, 10),
      endpoints: found,
    }
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`)
    console.log(
      `  snapshot rewritten (${found.length} endpoints) -> ${SNAPSHOT_PATH}`,
    )
    return
  }

  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.log("  no snapshot to diff against; rerun with --write-snapshot")
    return
  }
  const snapshot = JSON.parse(
    fs.readFileSync(SNAPSHOT_PATH, "utf8"),
  ) as SnapshotFile
  const diff = diffZcodeEndpoints(snapshot.endpoints, found)
  console.log(
    `  snapshot ${snapshot.clientVersion ?? "?"} (${snapshot.capturedAt ?? "?"}): ${snapshot.endpoints.length} endpoints`,
  )
  if (diff.added.length === 0 && diff.missing.length === 0) {
    console.log("  no drift")
    return
  }
  for (const endpoint of diff.added) console.log(`  + ${endpoint}`)
  for (const endpoint of diff.missing) console.log(`  - ${endpoint}`)
}

async function main(): Promise<void> {
  const connections = readZcodeConnections()
  const connection = pickAccount(connections, argValue("account"))
  if (!connection) {
    console.log(
      connections.length === 0 ?
        "No zcode connection in this data dir."
      : `No zcode connection with a session JWT matched --account.`,
    )
    process.exitCode = 1
    return
  }

  const appVersion = await resolveZcodeAppVersion()
  console.log(`\n== zcode probe ==`)
  console.log(`  account: ${connection.name} (${connection.id})`)
  console.log(`  jwt: ${zcodeSessionJwt(connection).length} chars`)
  console.log(
    `  client version: ${appVersion} (pinned floor ${ZCODE_APP_VERSION})`,
  )

  const platform = `${process.platform}-${process.arch}`
  const withVersion = (base: string) =>
    `${base}?app_version=${encodeURIComponent(appVersion)}&platform=${platform}`

  console.log("\n== upstream feeds ==")
  const probes: Array<RawProbe> = [
    {
      label: "billing/balance (auth sanity)",
      path: "/api/v1/zcode-plan/billing/balance",
    },
    {
      label: "marketing/touch (plan discovery)",
      path: "/api/v1/marketing/touch?seq=1",
      extract: (data) => planIds(collectMarketingPlans(data)),
    },
    {
      label: "billing/preview (retired)",
      path: withVersion("/api/v1/zcode-plan/billing/preview"),
      extract: (data) => planIds(parseZcodeClaimPlans(data)),
    },
    {
      label: "billing/current (unused)",
      path: withVersion("/api/v1/zcode-plan/billing/current"),
    },
  ]
  for (const probe of probes) {
    try {
      await probeRaw(connection, probe, appVersion)
    } catch (error) {
      console.log(`  ${probe.label}\n    request failed: ${String(error)}`)
    }
  }

  console.log("\n== what the claim round would do ==")
  try {
    const plans = await fetchZcodeClaimPlans(connection)
    if (plans.length === 0) {
      console.log("  no plans right now")
    } else {
      for (const plan of plans) {
        const grants = plan.grants
          .map((grant) => `${grant.name} ${grant.units}`)
          .join(", ")
        console.log(
          `  ${plan.planId}  ${plan.name}  [${grants || "no grants"}]`,
        )
      }
    }
  } catch (error) {
    console.log(`  failed: ${String(error)}`)
    process.exitCode = 1
  }

  await scanAsar(argValue("asar"))
}

await main()
