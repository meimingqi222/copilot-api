/**
 * ZCode Start Plan（体验套餐）接入。
 *
 * Z.ai / BigModel 账号没有 GLM Coding Plan 时，ZCode 给它的免费额度
 * （含活动期临时领的积分）走另一套端点：
 *
 *   - 请求打在 zcode.z.ai 自己的 /api/v1/zcode-plan/anthropic 下，
 *     用 ZCode 会话 JWT（登录轮询返回的 `token`）作 Bearer，不带 x-api-key；
 *     账号的 zcode-api-key 则只走 Coding Plan 计费，没有 plan 也没有
 *     API 余额时会被 1113「余额不足或没有资源包」拒掉。
 *   - 余额 /api/v1/zcode-plan/billing/balance 用同一个 JWT 读取，
 *     并要求 X-Device-Mid（缺了会 400 / code 3001）。
 *   - zcode.z.ai 会拦下不像 ZCode 应用的请求（405 / code 3012
 *     "request has been blocked due to unusual activity"），所以请求要
 *     带上 ZCode 的头（zcodeSourceHeaders）并按 ZCode 的形状重塑 body
 *     （shapeZcodeStartBody：三块缓存 system + 日期提醒 user turn +
 *     metadata.user_id = 设备 id）。magpie 实测同样的头体经 HTTP/1.1
 *     的 fetch 发出即可（Bun fetch 本身就是 HTTP/1.1，无需降级）。
 *
 * 临时积分只是 Start Plan 计费体系里的一个 plan + balance 桶：余额接口
 * 返回 plans[] / balances[]，过期的 plan（status "expired"，或 ends_at
 * 已过的 "active"）连同它的余额桶一起剔除，不会被误认为还有额度。
 *
 * 账号走哪条路（resolveZcodeRoute，缓存 10 分钟）：
 *   1. 没有 JWT → Coding Plan（老连接没有存 JWT）；
 *   2. 没有 API key → Start Plan；
 *   3. /api/biz/subscription/list 有 VALID 订阅 → Coding Plan，无 → Start；
 *   4. 订阅判断失败时，看 Start Plan 余额里有没有 active plan；
 *   5. 都问不出来 → 当 Coding Plan（保守，失败也只影响这一个连接）。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import {
  getConnectionProxyUrl,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import {
  ZCODE_API,
  ZCODE_APP_VERSION,
  ZCODE_BIGMODEL_ANTHROPIC_BASE,
} from "~/services/oauth/zcode"

import { ZCODE_PROMPT } from "./prompt"

export const ZCODE_START_PLAN_BASE = `${ZCODE_API}/api/v1/zcode-plan/anthropic`

const BALANCE_URL = `${ZCODE_API}/api/v1/zcode-plan/billing/balance`

/** Start Plan 提供的模型（Coding Plan 专属 GLM-5.3 不在其列）。 */
const ZCODE_START_PLAN_MODELS = new Set([
  "GLM-5.3-Flash",
  "GLM-5.2",
  "GLM-5-Turbo",
])

export const ZCODE_START_BLOCK_HINT =
  "ZCode's Start Plan still turned this request away, though copilot-api sends it as the ZCode app does; it can be a network block of this IP, or ZCode checking for something new. Use an account with a GLM Coding Plan, or add another provider to this group"

export const ZCODE_JWT_EXPIRED_HINT =
  "ZCode's sign-in has expired; add the account again to keep using its Start Plan credits"

// ── 设备 MID（X-Device-Mid / metadata.user_id） ─────────────────

const DEVICE_MID_FILE = "zcode-device-mid"
const DEVICE_MID_RE =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

let cachedDeviceMid: string | undefined

/**
 * 这台机器对 zcode.z.ai 报的 device id：ZCode 用设备 id 区分机器，
 * billing/balance 没它会 400（code 3001）。服务端只校验存在，
 * 所以我们自己在数据目录里持久化一个 UUID。
 */
export function zcodeDeviceMid(): string {
  if (cachedDeviceMid) return cachedDeviceMid
  const file = path.join(PATHS.APP_DIR, DEVICE_MID_FILE)
  try {
    const id = fs.readFileSync(file, "utf8").trim().toLowerCase()
    if (DEVICE_MID_RE.test(id)) {
      cachedDeviceMid = id
      return id
    }
  } catch {
    /* no saved id yet */
  }
  const id = crypto.randomUUID()
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 })
  } catch {
    /* keep the in-memory id for this run */
  }
  cachedDeviceMid = id
  return id
}

// ── 会话 JWT ────────────────────────────────────────────────────

/** 连接里存的 ZCode 会话 JWT（登录时落 credential.context.zcodeJwt）。 */
export function zcodeSessionJwt(connection: ProviderConnection): string {
  return getCredentialContextString(connection, "zcodeJwt") ?? ""
}

/** JWT 的 exp 是否已过；读不出 exp 当作未过期。 */
export function zcodeJwtExpired(jwt: string): boolean {
  const parts = jwt.split(".")
  if (parts.length !== 3) return false
  try {
    const claims = JSON.parse(
      Buffer.from(
        parts[1]!.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: number }
    if (!claims.exp) return false
    return Date.now() >= claims.exp * 1000
  } catch {
    return false
  }
}

// ── 余额（billing/balance） ─────────────────────────────────────

export interface ZcodeStartBalancePlan {
  planId: string
  userPlanId: string
  name: string
  status: string
  endsAt?: number
  entitlementPeriods: Map<string, string>
}

export interface ZcodeStartBalanceBucket {
  planId: string
  userPlanId: string
  entitlement: string
  showName: string
  capabilities: Array<string>
  total?: number
  used?: number
  remaining?: number
  expiresAt?: number
  periodStart?: number
  periodEnd?: number
}

export interface ZcodeStartBalance {
  plans: Array<ZcodeStartBalancePlan>
  balances: Array<ZcodeStartBalanceBucket>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function asNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * ZCode 的 JSON 端点，响应包在 {code,msg,data}：code 0/200 才算成功。
 * 与 services/oauth/zcode.ts 的 zcodeCall 同一约定；key 裸放 Authorization
 * （订阅/余额查询的 ZCode 惯例，不是 Bearer——Start Plan 除外，调用方
 * 自行传 `Bearer <jwt>`）。
 */
async function zcodeGet(
  connection: ProviderConnection | undefined,
  url: string,
  auth: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const options: OAuthFetchOptions = {}
  if (connection) {
    const proxyUrl = getConnectionProxyUrl(connection)
    if (proxyUrl) options.proxyUrl = proxyUrl
  }
  const response = await oauthFetch(
    url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `ZCode/${ZCODE_APP_VERSION}`,
        ...(auth ? { authorization: auth } : {}),
        ...headers,
      },
    },
    options,
  )
  const text = await response.text()
  let env: Record<string, unknown> = {}
  try {
    env = (JSON.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    env = {}
  }
  if (!response.ok) {
    throw new HTTPError(
      `ZCode request failed (HTTP ${response.status})`,
      new Response(text || response.statusText, { status: response.status }),
      text,
    )
  }
  const code = typeof env.code === "number" ? String(env.code) : asStr(env.code)
  if (code && code !== "0" && code !== "200" && code !== "null") {
    throw new HTTPError(
      asStr(env.msg) || `ZCode error ${code}`,
      new Response(text, { status: 502 }),
      text,
    )
  }
  return env.data ?? null
}

/**
 * 解析 billing/balance：把 plan 的 entitlements 折成 period 表，
 * 并把「已过期」的 plan（status expired，或 ends_at 已过的 active）
 * 连同其余额桶剔除——临时领的积分到期后不能继续显示成可用。
 */
export function parseZcodeStartBalance(
  data: unknown,
  nowSec?: number,
): ZcodeStartBalance {
  const root = asRecord(data)
  const now = nowSec ?? asNum(root?.server_time) ?? Date.now() / 1000
  const plans: Array<ZcodeStartBalancePlan> = []
  const expired = new Set<string>()
  for (const raw of Array.isArray(root?.plans) ? root.plans : []) {
    const p = asRecord(raw)
    if (!p) continue
    let status = asStr(p.status).toLowerCase()
    const endsAt = asNum(p.ends_at)
    if (
      status === "active"
      && endsAt !== undefined
      && endsAt > 0
      && endsAt <= now
    ) {
      status = "expired"
    }
    const plan: ZcodeStartBalancePlan = {
      planId: asStr(p.plan_id),
      userPlanId: asStr(p.user_plan_id),
      name: asStr(p.name),
      status,
      endsAt,
      entitlementPeriods: new Map(),
    }
    for (const rawE of Array.isArray(p.entitlements) ? p.entitlements : []) {
      const e = asRecord(rawE)
      if (e)
        plan.entitlementPeriods.set(asStr(e.entitlement_id), asStr(e.period))
    }
    plans.push(plan)
    if (plan.status === "expired")
      expired.add(`${plan.userPlanId}${plan.planId}`)
  }
  const balances: Array<ZcodeStartBalanceBucket> = []
  for (const raw of Array.isArray(root?.balances) ? root.balances : []) {
    const x = asRecord(raw)
    if (!x) continue
    const bucket: ZcodeStartBalanceBucket = {
      planId: asStr(x.plan_id),
      userPlanId: asStr(x.user_plan_id),
      entitlement: asStr(x.entitlement_id),
      showName: asStr(x.show_name),
      capabilities:
        Array.isArray(x.capabilities) ?
          x.capabilities.filter((c): c is string => typeof c === "string")
        : [],
      total: asNum(x.total_units),
      used: asNum(x.used_units),
      remaining: asNum(x.remaining_units),
      expiresAt: asNum(x.expires_at),
      periodStart: asNum(x.period_start),
      periodEnd: asNum(x.period_end),
    }
    const matchesPlan = (p: ZcodeStartBalancePlan) =>
      (bucket.userPlanId !== ""
        && p.userPlanId !== ""
        && bucket.userPlanId === p.userPlanId)
      || ((bucket.userPlanId === "" || p.userPlanId === "")
        && bucket.planId === p.planId)
    const owner = plans.find(matchesPlan)
    if (owner && expired.has(`${owner.userPlanId}${owner.planId}`)) continue
    balances.push(bucket)
  }
  return { plans, balances }
}

/** plan 的 plan_id / name 含 "start plan"/"start-plan"（或两者皆空）算 Start Plan。 */
export function isZcodeStartPlanName(name: string): boolean {
  const p = name.toLowerCase()
  return (
    p.includes("start plan")
    || p.includes("start-plan")
    || name.includes("体验")
  )
}

/** 当前生效的 Start Plan（名字与 id 皆空时也接受）。 */
export function zcodeActiveStartPlan(
  balance: ZcodeStartBalance,
): { name: string; untilMs?: number } | undefined {
  for (const p of balance.plans) {
    if (p.status !== "active") continue
    if (p.planId || p.name) {
      const id = p.planId.toLowerCase()
      const name = p.name.toLowerCase()
      if (
        !id.includes("start-plan")
        && !id.includes("start plan")
        && !name.includes("start-plan")
        && !name.includes("start plan")
      ) {
        continue
      }
    }
    return {
      name: p.name || "Start Plan",
      untilMs: p.endsAt && p.endsAt > 0 ? p.endsAt * 1000 : undefined,
    }
  }
  return undefined
}

/** 读 Start Plan 余额；JWT 缺失或过期直接抛错。 */
export async function zcodeStartBalance(
  connection: ProviderConnection,
  jwt: string,
): Promise<ZcodeStartBalance> {
  if (!jwt) throw new Error("not signed in to ZCode")
  if (zcodeJwtExpired(jwt)) throw new Error(ZCODE_JWT_EXPIRED_HINT)
  const url =
    `${BALANCE_URL}?`
    + new URLSearchParams({ app_version: ZCODE_APP_VERSION }).toString()
  const data = await zcodeGet(connection, url, `Bearer ${jwt}`, {
    "X-Device-Mid": zcodeDeviceMid(),
  })
  return parseZcodeStartBalance(data)
}

// ── 路由判定（Start Plan vs Coding Plan） ───────────────────────

export type ZcodeRoute = "start" | "coding"

interface RouteEntry {
  route: ZcodeRoute
  at: number
  ttlMs: number
}

const routeCache = new Map<string, RouteEntry>()

/** 测试用：清掉路由缓存。 */
export function __resetZcodeRouteCacheForTest(): void {
  routeCache.clear()
}

const ROUTE_TTL_SURE_MS = 10 * 60 * 1000
const ROUTE_TTL_UNSURE_MS = 60 * 1000

/** 账号有没有 GLM Coding Plan：/api/biz/subscription/list 有无 VALID。 */
async function zcodeHasCodingPlan(
  connection: ProviderConnection,
  key: string,
  root: string,
): Promise<boolean> {
  const data = await zcodeGet(
    connection,
    `${root}/api/biz/subscription/list`,
    key,
  )
  const subs = Array.isArray(data) ? data : []
  return subs.some((raw) => {
    const s = asRecord(raw)
    return s && asStr(s.status).toUpperCase() === "VALID"
  })
}

async function decideZcodeRoute(
  connection: ProviderConnection,
  key: string,
  jwt: string,
  root: string,
): Promise<{ route: ZcodeRoute; sure: boolean }> {
  try {
    const has = await zcodeHasCodingPlan(connection, key, root)
    return { route: has ? "coding" : "start", sure: true }
  } catch {
    /* fall through to the Start Plan check */
  }
  try {
    const balance = await zcodeStartBalance(connection, jwt)
    if (zcodeActiveStartPlan(balance)) return { route: "start", sure: true }
  } catch {
    /* can't tell either way */
  }
  return { route: "coding", sure: false }
}

/**
 * 这个连接的请求该打到哪个 plan。
 * `cached`（如 quota 预检只想要上次结论、不想额外发请求）时只看缓存，
 * 没有缓存按「有 JWT + 无 key → start，否则 coding」的静态判断。
 */
export async function resolveZcodeRoute(
  connection: ProviderConnection,
  credential: ApiCredential,
  opts?: { cached?: boolean; signal?: AbortSignal },
): Promise<ZcodeRoute> {
  const jwt = zcodeSessionJwt(connection)
  if (!jwt) return "coding"
  const key =
    credential.value
    || getCredentialContextString(connection, "accessToken")
    || ""
  if (!key) return "start"
  const cacheKey = `${key}${jwt}`
  const hit = routeCache.get(cacheKey)
  if (opts?.cached) {
    if (hit) return hit.route
    return key ? "coding" : "start"
  }
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.route
  // 判定请求是后台探测，不带调用方的 signal。
  const base = getCredentialContextString(connection, "base") ?? ""
  let root = "https://api.z.ai"
  try {
    root = new URL(base).origin
  } catch {
    /* base 缺失或畸形时用默认 */
  }
  const { route, sure } = await decideZcodeRoute(connection, key, jwt, root)
  routeCache.set(cacheKey, {
    route,
    at: Date.now(),
    ttlMs: sure ? ROUTE_TTL_SURE_MS : ROUTE_TTL_UNSURE_MS,
  })
  return route
}

/** Start Plan 是否提供这个模型（按 upstream model id）。 */
export function zcodeStartServes(model: string): boolean {
  return ZCODE_START_PLAN_MODELS.has(model)
}

// ── 请求指纹（头） ──────────────────────────────────────────────

function zcodePlatform(): string {
  return process.platform // Node 的叫法与 ZCode 一致：win32/darwin/linux
}

function zcodeArch(): string {
  return process.arch // x64 / arm64，与 Node 一致
}

function zcodeOSVersion(): string {
  return `${zcodePlatform()} ${os.release()} ${zcodeArch()}`
}

function zcodeLanguage(): string {
  const bcp47 = (v: string | undefined): string => {
    if (!v) return ""
    let s = v.split(".")[0]!.split("@")[0]!.trim()
    if (!s || s === "C" || s === "POSIX") return ""
    return s.replaceAll("_", "-")
  }
  for (const k of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const l = bcp47(process.env[k])
    if (l) return l
  }
  const resolved = Intl.DateTimeFormat().resolvedOptions().locale
  return resolved || "en-US"
}

function zcodeTimezone(): string {
  if (process.env.TZ && !process.env.TZ.startsWith(":")) return process.env.TZ
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (name) return name
  const off = -new Date().getTimezoneOffset() / 60 // 与 Go 的 Zone offset 同号
  if (off === 8) return "Asia/Shanghai"
  if (off === 0) return "UTC"
  return off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`
}

/**
 * Start Plan 请求要带的一套 ZCode 应用头（magpie 对照过 ZCode 桌面端
 * 3.14 与其服务的 OpenCode 插件的请求）：
 * 不带 anthropic-beta、不带 query/session id、不带 X-Device-Mid。
 * 返回头名 → 值；调用方负责 merge。
 */
export function zcodeSourceHeaders(): Record<string, string> {
  const category =
    process.platform === "darwin" ? "macos"
    : process.platform === "win32" ? "windows"
    : "linux"
  return {
    "anthropic-version": "2023-06-01",
    "User-Agent": `ZCode/${ZCODE_APP_VERSION} ai-sdk/anthropic/3.0.81`,
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Title": "Z Code@cli",
    "X-ZCode-Agent": "glm",
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Platform": `${zcodePlatform()}-${zcodeArch()}`,
    "X-Os-Category": category,
    "X-Os-Version": zcodeOSVersion(),
    "X-Release-Channel": "production",
    "X-Client-Language": zcodeLanguage(),
    "X-Client-Timezone": zcodeTimezone(),
    "X-Request-Id": crypto.randomUUID(),
    "X-ZCode-Session-Type": "main",
    "X-ZCode-Trace-Id": crypto.randomUUID(),
  }
}

// ── 请求体重塑 ──────────────────────────────────────────────────

interface JsonObject {
  [key: string]: unknown
}

/** powered-by 行里的 provider 名（BigModel 是 bigmodel-api）。 */
export function zcodeStartProvider(base: string): string {
  return base === ZCODE_BIGMODEL_ANTHROPIC_BASE ? "bigmodel-api" : "zai-api"
}

const CWD_RE =
  /(?:^\s*-?\s*(?:Primary working directory|Working directory):[ \t]*([^\r\n]+?)[ \t]*$|<cwd>([^<\r\n]+)<\/cwd>)/m

function zcodeCwd(texts: Array<string>): string {
  for (const t of texts) {
    const m = CWD_RE.exec(t)
    if (m) return (m[1] ?? m[2] ?? "").trim()
  }
  return os.homedir() || "unknown"
}

function zcodeShell(): string {
  for (const k of ["SHELL", "ComSpec"]) {
    const s = process.env[k]
    if (s) return s.split(/[\\/]/).pop() || "unknown"
  }
  return "unknown"
}

function zcodeEnvironment(
  provider: string,
  model: string,
  cwd: string,
): string {
  const e = ZCODE_PROMPT.environment
  const lines = [
    e.heading,
    e.invokedLine,
    `- ${e.cwdLabel}: ${cwd}`,
    `- ${e.gitLabel}: ${e.gitNo}`,
    `- ${e.platformLabel}: ${zcodePlatform()}`,
    `- ${e.shellLabel}: ${zcodeShell()}`,
    `- ${e.osVersionLabel}: ${zcodeOSVersion()}`,
  ]
  if (model) {
    lines.push(
      e.poweredByLine
        .replaceAll("{provider}", provider)
        .replaceAll("{model}", model),
    )
  }
  return lines.join("\n")
}

function cachedBlock(text: string): JsonObject {
  return { type: "text", text, cache_control: { type: "ephemeral" } }
}

/** ZCode 的三块 system（全部带 cache_control: ephemeral）。 */
function zcodeSystem(
  provider: string,
  model: string,
  cwd: string,
): Array<JsonObject> {
  const stable = `${ZCODE_PROMPT.stable}\n\n${ZCODE_PROMPT.desktop}`
  const dynamic = [
    ZCODE_PROMPT.beforeEnvironment,
    zcodeEnvironment(provider, model, cwd),
    ZCODE_PROMPT.afterEnvironment,
  ].join("\n\n")
  return [
    cachedBlock(ZCODE_PROMPT.prefix),
    cachedBlock(stable),
    cachedBlock(`\n\n${dynamic}`),
  ]
}

/** 上下文前缀：当天日期包在 <system-reminder> 里，作为第一个 user turn。 */
function zcodeDateReminder(now: Date): JsonObject {
  const c = ZCODE_PROMPT.context
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const text = [
    c.intro,
    `${c.currentDateHeading}\n${c.currentDateLine.replaceAll("{date}", date)}`,
    "",
    c.outro,
  ].join("\n")
  return {
    role: "user",
    content: [
      { type: "text", text: `<system-reminder>${text}</system-reminder>` },
    ],
  }
}

function zcodeUserID(): string {
  return JSON.stringify({
    device_id: zcodeDeviceMid(),
    account_uuid: "",
    session_id: "",
  })
}

/**
 * 把一条 Anthropic messages payload 改造成 Start Plan 要的样子：
 *   - system 换成 ZCode 的三块缓存 system，agent 自己的 system 文本接在后面（不缓存）；
 *   - 第一条消息前插日期提醒 user turn；
 *   - 清掉 messages/tools 里所有 cache_control，只给最后一条非 system
 *     消息的最后一个内容块补 ephemeral；
 *   - metadata.user_id = 设备 id。
 * payload 不是 messages 请求、或 system 第一块已是 ZCode prefix（防重复注入）时原样返回。
 */
export function shapeZcodeStartBody(
  payload: JsonObject,
  provider: string,
  now = new Date(),
): JsonObject {
  if (!Array.isArray(payload.messages)) return payload
  const model = typeof payload.model === "string" ? payload.model : ""

  const own: Array<JsonObject> = []
  const texts: Array<string> = []
  const rawSystem = payload.system
  if (typeof rawSystem === "string") {
    if (rawSystem.trim()) {
      own.push({ type: "text", text: rawSystem })
      texts.push(rawSystem)
    }
  } else if (Array.isArray(rawSystem)) {
    for (const b of rawSystem) {
      const block = asRecord(b)
      const text = asStr(block?.text)
      if (block?.type !== "text" || !text) continue
      if (text === ZCODE_PROMPT.prefix && own.length === 0) return payload
      own.push({ type: "text", text })
      texts.push(text)
    }
  } else if (rawSystem !== undefined && rawSystem !== null) {
    return payload
  }

  const msgs = payload.messages.filter((m): m is JsonObject => !!asRecord(m))
  if (msgs.length !== payload.messages.length) return payload
  const first = msgs[0]
  if (first) {
    const c = first.content
    if (typeof c === "string") {
      texts.push(c)
    } else if (Array.isArray(c)) {
      for (const b of c) {
        const t = asStr(asRecord(b)?.text)
        if (t) texts.push(t)
      }
    }
  }

  const system = [...zcodeSystem(provider, model, zcodeCwd(texts)), ...own]

  const outMsgs: Array<JsonObject> = [zcodeDateReminder(now), ...msgs]
  let lastAt = -1
  for (const [i, msg] of outMsgs.entries()) {
    if (msg.role === "system") continue
    lastAt = i
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const block = asRecord(b)
        if (block) delete block.cache_control
      }
    }
  }
  if (lastAt >= 0) {
    const last = outMsgs[lastAt]!
    const c = last.content
    if (typeof c === "string") {
      last.content = [
        { type: "text", text: c, cache_control: { type: "ephemeral" } },
      ]
    } else if (Array.isArray(c) && c.length > 0) {
      const block = asRecord(c[c.length - 1])
      if (block) block.cache_control = { type: "ephemeral" }
    }
  }

  const tools = payload.tools
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const tool = asRecord(t)
      if (tool) delete tool.cache_control
    }
  }

  const meta: JsonObject = { ...asRecord(payload.metadata) }
  meta.user_id = zcodeUserID()

  return { ...payload, system, messages: outMsgs, metadata: meta }
}
