/**
 * ZCode 领取链路诊断（**不进 CI**，需要真实账号的会话 JWT）。
 *
 * 用法：
 *   bun run scripts/live/zcode-probe.ts                 # 第一个可用账号
 *   bun run scripts/live/zcode-probe.ts --account 71f2  # id 或名字的子串
 *   bun run scripts/live/zcode-probe.ts --asar <path>   # 顺带列出客户端认识的投放路径
 *
 * 回答的问题：上游现在把「可领套餐」放在哪个接口、我们的抽取器还能不能
 * 认出来（`data: NO` = 接口已退役，不是今天没活动）。JWT 只报长度，绝不打印。
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
  resolveZcodeAppVersion,
  ZCODE_API,
  ZCODE_APP_VERSION,
} from "~/services/oauth/zcode"

/** 会随上游改版搬迁的端点前缀。 */
const TRACKED_PREFIXES = [
  "/api/v1/zcode-plan",
  "/api/v1/marketing",
  "/api/v1/releases",
  "/api/v1/client/configs",
  "/api/v1/oauth",
]

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : ""
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

/**
 * `--asar`：官方客户端里还有哪些投放相关路径。
 *
 * 只回答「客户端还认不认识 X」，不做基线对比——今天这次故障是**服务端**
 * 退役了 preview 而客户端字符串还在，基线 diff 只会报 no drift，属于自欺。
 * 分块读，340MB 的 asar 不会整体进内存。
 */
function scanAsarPaths(asarPath: string): Array<string> {
  const found = new Set<string>()
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  const fd = fs.openSync(asarPath, "r")
  let carry = ""
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      const text = carry + chunk.subarray(0, read).toString("latin1")
      for (const match of text.matchAll(/\/api\/v1\/[A-Za-z0-9._~/-]+/g)) {
        const path = match[0].replace(/[/.,;:'")\]}]+$/, "")
        if (TRACKED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
          found.add(path)
        }
      }
      carry = text.slice(-128)
    }
  } finally {
    fs.closeSync(fd)
  }
  return [...found].sort()
}

function reportAsar(aspectPath: string | undefined): void {
  const asarPath = aspectPath || defaultAsarPath()
  if (!asarPath || !fs.existsSync(asarPath)) {
    console.log(
      `\n== client endpoints ==\n  skipped (${asarPath ? `not found: ${asarPath}` : "no app.asar; pass --asar <path>"})`,
    )
    return
  }
  console.log(`\n== client endpoints ==\n  ${asarPath}`)
  for (const endpoint of scanAsarPaths(asarPath)) console.log(`  ${endpoint}`)
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

  reportAsar(argValue("asar"))
}

await main()
