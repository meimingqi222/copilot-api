import { Hono } from "hono"

import { saveGuard } from "~/lib/client-guard/persistence"
import {
  addBlacklistEntry,
  addUaWhitelistPattern,
  getBlacklist,
  getCustomUaWhitelist,
  getSnapshots,
  getUaWhitelist,
  removeBlacklistEntry,
  removeUaWhitelistPattern,
} from "~/lib/guard"
import {
  DEFAULT_GUARD_CONFIG,
  getGuardConfig,
  setGuardConfig,
  validateGuardConfigPatch,
} from "~/lib/guard-config"
import {
  blockPrincipal,
  listShadowStats,
  listTempBlocks,
  unblockPrincipal,
} from "~/lib/protected-route-guard"
import { readJsonBody } from "~/lib/request-body"
import { state } from "~/lib/state"

export const guardApiRoutes = new Hono()

// GET /api/guard/clients?type=ip|ua
guardApiRoutes.get("/clients", (c) => {
  const type = c.req.query("type") === "ua" ? "ua" : "ip"
  return c.json({ clients: getSnapshots(type) })
})

// GET /api/guard/blacklist
guardApiRoutes.get("/blacklist", (c) => {
  return c.json({ blacklist: getBlacklist() })
})

// POST /api/guard/blacklist  { value, type, reason? }
guardApiRoutes.post("/blacklist", async (c) => {
  let body: {
    value?: string
    type?: "ip" | "ua"
    reason?: string
    expiresAt?: number
  }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const value = body.value?.trim()
  if (!value) {
    return c.json({ error: "value is required." }, 400)
  }
  const type = body.type === "ua" ? "ua" : "ip"
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ?
      body.expiresAt
    : undefined

  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return c.json({ error: "expiresAt must be in the future." }, 400)
  }

  const entry = await addBlacklistEntry({
    value,
    type,
    reason: body.reason,
    source: "manual",
    expiresAt,
  })
  return c.json({ entry })
})

// DELETE /api/guard/blacklist  { value, type }
guardApiRoutes.delete("/blacklist", async (c) => {
  let body: { value?: string; type?: "ip" | "ua" }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const value = body.value?.trim()
  if (!value) {
    return c.json({ error: "value is required." }, 400)
  }
  const type = body.type === "ua" ? "ua" : "ip"

  const ok = await removeBlacklistEntry({ value, type })
  if (!ok) return c.json({ error: "Entry not found." }, 404)
  return c.json({ ok: true })
})

// GET /api/guard/ua-whitelist
guardApiRoutes.get("/ua-whitelist", (c) => {
  return c.json({
    builtin: getUaWhitelist().filter(
      (p) => !getCustomUaWhitelist().includes(p),
    ),
    custom: getCustomUaWhitelist(),
  })
})

// POST /api/guard/ua-whitelist  { pattern }
guardApiRoutes.post("/ua-whitelist", async (c) => {
  let body: { pattern?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const pattern = body.pattern?.trim()
  if (!pattern) return c.json({ error: "pattern is required." }, 400)
  const currentCustom = getCustomUaWhitelist()
  if (currentCustom.includes(pattern.toLowerCase())) {
    return c.json({ error: "Pattern already exists in whitelist." }, 409)
  }
  await addUaWhitelistPattern(pattern)
  return c.json({ ok: true })
})

// DELETE /api/guard/ua-whitelist  { pattern }
guardApiRoutes.delete("/ua-whitelist", async (c) => {
  let body: { pattern?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const pattern = body.pattern?.trim()
  if (!pattern) return c.json({ error: "pattern is required." }, 400)
  const ok = await removeUaWhitelistPattern(pattern)
  if (!ok) return c.json({ error: "Pattern not found." }, 404)
  return c.json({ ok: true })
})

function usernameForUserId(userId: string): string | undefined {
  return state.users.find((u) => u.id === userId)?.username
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i

function normalizePrincipal(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim()
  if (!v) return undefined
  if (v.startsWith("user:") || v.startsWith("key:")) {
    return v.length > 5 ? v : undefined
  }
  if (v.startsWith("ip:")) {
    const ip = v.slice(3).trim()
    return ip && (IPV4_RE.test(ip) || IPV6_RE.test(ip)) ? `ip:${ip}` : undefined
  }
  // Bare IP without prefix.
  if (IPV4_RE.test(v) || IPV6_RE.test(v)) return `ip:${v}`
  return undefined
}

// GET /api/guard/temp-blocks — in-memory protected-route-guard blocks
guardApiRoutes.get("/temp-blocks", (c) => {
  const blocks = listTempBlocks().map((b) => ({
    ...b,
    username: b.userId ? usernameForUserId(b.userId) : undefined,
  }))
  return c.json({ blocks })
})

// POST /api/guard/temp-blocks  { principal, durationMs?, reason? }
guardApiRoutes.post("/temp-blocks", async (c) => {
  let body: { principal?: string; durationMs?: number; reason?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const normalized = normalizePrincipal(body.principal)
  if (!normalized) {
    return c.json(
      {
        error: "principal must be user:<id>, key:<fp>, ip:<addr>, or a raw IP.",
      },
      400,
    )
  }
  const principal = normalized
  let durationMs: number | undefined
  if (body.durationMs !== undefined) {
    if (
      typeof body.durationMs !== "number"
      || !Number.isFinite(body.durationMs)
      || body.durationMs < 60_000
      || body.durationMs > 7 * 24 * 60 * 60 * 1000
    ) {
      return c.json(
        { error: "durationMs must be between 60000 and 604800000." },
        400,
      )
    }
    durationMs = Math.floor(body.durationMs)
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim() ?
      body.reason.trim().slice(0, 200)
    : undefined
  const block = blockPrincipal(principal, { durationMs, reason })
  return c.json({
    block: {
      ...block,
      username: block.userId ? usernameForUserId(block.userId) : undefined,
    },
  })
})

// DELETE /api/guard/temp-blocks  { principal }
guardApiRoutes.delete("/temp-blocks", async (c) => {
  let body: { principal?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const principal = normalizePrincipal(body.principal)
  if (!principal) return c.json({ error: "principal is required." }, 400)
  const ok = unblockPrincipal(principal)
  if (!ok) return c.json({ error: "Principal not found." }, 404)
  return c.json({ ok: true })
})

// GET /api/guard/overview — header cards for the new Blocks-first UI
guardApiRoutes.get("/overview", (c) => {
  const blocks = listTempBlocks()
  const blacklist = getBlacklist()
  const ipClients = getSnapshots("ip")
  const suspicious = ipClients.filter((cl) => cl.suspicious).length
  const recommended = ipClients.filter(
    (cl) => !cl.blocked && cl.recommendedAction === "temporary_block",
  ).length
  return c.json({
    tempBlocked: blocks.length,
    blacklisted: blacklist.length,
    blocked: blacklist.length,
    suspicious,
    recommended,
    total: ipClients.length,
    totalClients: ipClients.length,
    lastUpdated: Date.now(),
  })
})

// GET /api/guard/principals — unified principal-centric view (P1)
// Merges temp blocks (authoritative) with ip snapshots (traffic context).
guardApiRoutes.get("/principals", (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 500)
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 500, 1),
    2000,
  )
  const principals = buildPrincipals()
  return c.json({
    principals: principals.slice(0, limit),
    total: principals.length,
  })
})

type TempBlock = ReturnType<typeof listTempBlocks>[number]
type IpSnapshot = ReturnType<typeof getSnapshots>[number]

function buildPrincipals(): Array<Record<string, unknown>> {
  const blocks = listTempBlocks()
  const ipClients = getSnapshots("ip")
  const ipByKey = new Map(ipClients.map((cl) => [cl.key, cl]))
  const blacklistKeys = new Set(getBlacklist().map((e) => e.value))
  const principals: Array<Record<string, unknown>> = []
  const coveredIps = new Set<string>()

  for (const entry of buildBlockedPrincipals(blocks, ipByKey)) {
    if (entry.coveredIp) coveredIps.add(entry.coveredIp)
    principals.push(entry.row)
  }
  for (const row of buildObservedPrincipals(ipClients, blocks, blacklistKeys)) {
    if (coveredIps.has(row.clientIp as string)) continue
    principals.push(row)
  }
  sortPrincipals(principals)
  return principals
}

function buildBlockedPrincipals(
  blocks: Array<TempBlock>,
  ipByKey: Map<string, IpSnapshot>,
): Array<{ row: Record<string, unknown>; coveredIp?: string }> {
  return blocks.map((b) => {
    const snap = findSnapshotForBlock(b, ipByKey)
    const username = b.userId ? usernameForUserId(b.userId) : undefined
    return {
      coveredIp: snap?.key,
      row: {
        principal: b.principal,
        key: b.principal,
        kind: b.kind,
        userId: b.userId,
        username,
        usernames: username ? [username] : (snap?.usernames ?? []),
        clientIp: b.clientIp ?? (snap ? snap.key : undefined),
        userAgent: b.userAgent,
        lastPath: b.path,
        lastModel: b.model,
        requests: snap?.requests ?? b.recentRequestCount,
        errors: snap?.errors ?? 0,
        errorRate: snap?.errorRate ?? 0,
        burstRequests: snap?.burstRequests ?? b.recentRequestCount,
        recentRequests: snap?.recentRequests ?? b.recentRequestCount,
        topPaths: snap?.topPaths ?? [],
        flaggedRequests: snap?.flaggedRequests ?? [],
        firstSeenAt: snap?.firstSeenAt,
        lastSeenAt: b.lastSeen,
        userInitiatorCount: snap?.userInitiatorCount ?? 0,
        agentInitiatorCount: snap?.agentInitiatorCount ?? 0,
        authFailures: snap?.authFailures ?? 0,
        notFounds: snap?.notFounds ?? 0,
        tempBlocked: true,
        blocked: true,
        tempBlock: { ...b, username },
        blacklisted: snap ? snap.blocked : false,
        riskLevel: snap?.riskLevel ?? "high",
        score: snap?.suspiciousScore ?? 80,
        suspiciousScore: snap?.suspiciousScore ?? 80,
        suspicious: snap?.suspicious ?? true,
        reasons: snap?.suspiciousReasons ?? [],
        suspiciousReasons: snap?.suspiciousReasons ?? [],
        recommendedAction: snap?.recommendedAction ?? "temporary_block",
        lastSeen: b.lastSeen,
      },
    }
  })
}

function findSnapshotForBlock(
  b: TempBlock,
  ipByKey: Map<string, IpSnapshot>,
): IpSnapshot | undefined {
  return (
    (b.clientIp ? ipByKey.get(b.clientIp) : undefined)
    ?? (b.principal.startsWith("ip:") ?
      ipByKey.get(b.principal.slice(3))
    : undefined)
  )
}

function buildObservedPrincipals(
  ipClients: Array<IpSnapshot>,
  blocks: Array<TempBlock>,
  blacklistKeys: Set<string>,
): Array<Record<string, unknown>> {
  const blockPrincipals = new Set(blocks.map((b) => b.principal))
  const blockByIp = new Map<string, TempBlock>()
  for (const b of blocks) {
    if (b.clientIp && !blockByIp.has(b.clientIp)) blockByIp.set(b.clientIp, b)
  }
  const rows: Array<Record<string, unknown>> = []
  for (const cl of ipClients) {
    if (blockPrincipals.has(`ip:${cl.key}`)) continue
    const rawTemp = blockByIp.get(cl.key)
    const tempByIp =
      rawTemp && rawTemp.userId ?
        { ...rawTemp, username: usernameForUserId(rawTemp.userId) }
      : rawTemp
    rows.push({
      principal: `ip:${cl.key}`,
      key: `ip:${cl.key}`,
      kind: "ip",
      clientIp: cl.key,
      userAgent: undefined,
      usernames: cl.usernames,
      lastPath: cl.topPaths[0]?.path,
      requests: cl.requests,
      errors: cl.errors,
      errorRate: cl.errorRate,
      burstRequests: cl.burstRequests,
      recentRequests: cl.recentRequests,
      topPaths: cl.topPaths,
      flaggedRequests: cl.flaggedRequests,
      firstSeenAt: cl.firstSeenAt,
      lastSeenAt: cl.lastSeenAt,
      userInitiatorCount: cl.userInitiatorCount,
      agentInitiatorCount: cl.agentInitiatorCount,
      authFailures: cl.authFailures,
      notFounds: cl.notFounds,
      tempBlocked: Boolean(tempByIp),
      blocked: cl.blocked || blacklistKeys.has(cl.key) || Boolean(tempByIp),
      tempBlock: tempByIp ?? undefined,
      blacklisted: cl.blocked || blacklistKeys.has(cl.key),
      riskLevel: cl.riskLevel,
      score: cl.suspiciousScore,
      suspiciousScore: cl.suspiciousScore,
      suspicious: cl.suspicious,
      reasons: cl.suspiciousReasons,
      suspiciousReasons: cl.suspiciousReasons,
      recommendedAction: cl.recommendedAction,
      lastSeen: cl.lastSeenAt,
    })
  }
  return rows
}

function sortPrincipals(rows: Array<Record<string, unknown>>): void {
  rows.sort((a, b) => {
    const at = a.tempBlocked ? 1 : 0
    const bt = b.tempBlocked ? 1 : 0
    if (at !== bt) return bt - at
    const ab = a.blacklisted ? 1 : 0
    const bb = b.blacklisted ? 1 : 0
    if (ab !== bb) return bb - ab
    return (
      (Number(b.score) || 0) - (Number(a.score) || 0)
      || (Number(b.requests) || 0) - (Number(a.requests) || 0)
    )
  })
}

// GET /api/guard/config
guardApiRoutes.get("/config", (c) => {
  return c.json({ config: getGuardConfig(), defaults: DEFAULT_GUARD_CONFIG })
})

// GET /api/guard/shadow-stats — would-block counts while shadowMode is on
guardApiRoutes.get("/shadow-stats", (c) => {
  return c.json({
    shadowMode: getGuardConfig().shadowMode,
    stats: listShadowStats(),
  })
})

// PUT /api/guard/config  partial update, persisted to guard.json
guardApiRoutes.put("/config", async (c) => {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const validated = validateGuardConfigPatch(body)
  if (!validated.ok) return c.json({ error: validated.error }, 400)
  const config = setGuardConfig(validated.patch)
  await saveGuard()
  return c.json({ config })
})
