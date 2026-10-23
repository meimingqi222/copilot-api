/**
 * ZCode 限时套餐领取（活动赠送的「周末鸡蛋」）。
 *
 * 链路（与 zcode2api / zcode-switch 对齐）：
 *
 *   1. `GET {zcode}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *      —— 免验证码，列出当前可领套餐；活动没上线时上游回 404（正常态，视为空）。
 *   2. `POST {zcode}/api/v1/zcode-plan/billing/claim` body `{plan_id}`
 *      —— 必须带 `X-Aliyun-Captcha-Verify-Param`（+ Region），否则 3007；
 *      验证码由 ~/services/zcode/captcha 在真 Chromium 里求。
 *
 * 上游业务码：1001 套餐不存在 / 1002 活动结束 / 1003 已领过 / 1004 不符合
 * 条件 / 1005 今日名额用完（data.plan.ends_at 是名额恢复时间）/ 3001 参数错
 * / 3007 验证码被拒 / 401 未登录。1005 的恢复时间记进 connection.metadata
 * 的 holds，等待期内这个账号整轮跳过（省验证码与上游写流量），到恢复时间
 * 或一小时后自然重试。
 *
 * 自动轮（runZcodeClaimRound）由系统设置 zcodeAutoClaim 开关控制，每号
 * 默认 60 分钟一轮：先 preview，再逐个领取未被 hold 的套餐。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import {
  connectionProvider,
  getConnectionProxyUrl,
  listAccountManagedConnections,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import { getSystemSettings } from "~/lib/system-config"
import { oauthFetch } from "~/services/oauth/fetch"
import { ZCODE_API, ZCODE_APP_VERSION } from "~/services/oauth/zcode"

import { getZcodeVerifyParam, invalidateZcodeVerifyParam } from "./captcha"
import {
  zcodeBillingHeaders,
  zcodeDeviceMid,
  zcodeJwtExpired,
  zcodeSessionJwt,
} from "./start-plan"

const BILLING_BASE = `${ZCODE_API}/api/v1/zcode-plan`
const CLAIM_STATE_KEY = "zcodeClaim"
const ROUND_INTERVAL_MS = 60 * 60 * 1000
const PREVIEW_TIMEOUT_MS = 20_000
const CLAIM_TIMEOUT_MS = 180_000

interface ZcodeClaimGrant {
  name: string
  units: number
  period: string
}

interface ZcodeClaimPlan {
  planId: string
  name: string
  description: string
  priority: number
  grants: Array<ZcodeClaimGrant>
}

interface ZcodeClaimResult {
  planId: string
  planName: string
  grants: Array<ZcodeClaimGrant>
  startsAtMs?: number
  endsAtMs?: number
  serverTimeMs?: number
}

export interface ZcodeClaimState {
  /** 上次 preview 成功/失败的时间。 */
  checkedAt?: number
  /** 最近一次 preview 的结果。 */
  plans?: Array<ZcodeClaimPlan>
  /** planId → 名额恢复时间（1005 的 ends_at）。 */
  holds?: Record<string, number>
  lastError?: string
  lastErrorAt?: number
  lastClaim?: { planId: string; planName: string; at: number }
  /** 自动轮下次尝试时间。 */
  nextAttemptAt?: number
}

export class ZcodeClaimError extends Error {
  /** 上游业务码；-1 表示本地/网络错误。 */
  readonly code: number
  /** 1005 专用：名额恢复时间（毫秒）。 */
  readonly nextAtMs?: number

  constructor(message: string, code = -1, nextAtMs?: number) {
    super(message)
    this.name = "ZcodeClaimError"
    this.code = code
    this.nextAtMs = nextAtMs
  }
}

const FAIL_MESSAGES: Record<number, string> = {
  401: "Sign in to ZCode again before claiming.",
  1001: "This plan no longer exists.",
  1002: "The activity has ended or the plan is not available right now.",
  1003: "This plan has already been claimed.",
  1004: "This account is not eligible for the plan.",
  1005: "Today's claim quota is used up.",
  3001: "The claim was rejected (parameter error).",
  3007: "The captcha was rejected; it will be refreshed on the next attempt.",
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function businessCode(body: Record<string, unknown>): number {
  const code = asNum(body.code)
  return code === undefined ? 0 : code
}

function failError(
  code: number,
  body: Record<string, unknown>,
): ZcodeClaimError {
  const base = FAIL_MESSAGES[code] ?? `ZCode rejected the claim (code ${code}).`
  const detail = asStr(body.msg) || asStr(body.message)
  const message =
    detail && !base.includes(detail) ? `${base} (${detail})` : base
  let nextAtMs: number | undefined
  if (code === 1005) {
    const ends = asNum(asRecord(asRecord(body.data)?.plan)?.ends_at)
    if (ends !== undefined && ends > 0) nextAtMs = Math.round(ends * 1000)
  }
  return new ZcodeClaimError(message, code, nextAtMs)
}

/** 解析 preview 的 data（也接受未拆包的 {data:{plans}}）。 */
function coercePlan(raw: unknown): ZcodeClaimPlan | undefined {
  const plan = asRecord(raw)
  if (!plan) return undefined
  const planId = asStr(plan.plan_id) || asStr(plan.planId)
  if (!planId) return undefined
  const grants: Array<ZcodeClaimGrant> = []
  // 存储态（metadata）里是已解析的 grants；上游是 entitlements。
  const stored = Array.isArray(plan.grants) ? plan.grants : []
  for (const rawGrant of stored) {
    const grant = asRecord(rawGrant)
    const name = asStr(grant?.name)
    if (!grant || !name) continue
    grants.push({
      name,
      units: asNum(grant.units) ?? 0,
      period: asStr(grant.period) || "one_time",
    })
  }
  for (const rawGrant of Array.isArray(plan.entitlements) ?
    plan.entitlements
  : []) {
    const grant = asRecord(rawGrant)
    if (!grant) continue
    if (asStr(grant.meter) !== "model_usage") continue
    if (asStr(grant.unit_type) !== "token") continue
    const name = asStr(grant.show_name) || asStr(grant.showName)
    if (!name) continue
    grants.push({
      name,
      units: asNum(grant.grant_units) ?? asNum(grant.grantUnits) ?? 0,
      period: asStr(grant.period) || "one_time",
    })
  }
  return {
    planId,
    name: asStr(plan.name) || planId,
    description: asStr(plan.description),
    priority: asNum(plan.priority) ?? 0,
    grants,
  }
}

export function parseZcodeClaimPlans(raw: unknown): Array<ZcodeClaimPlan> {
  const root = asRecord(raw)
  if (!root) return []
  const nested = asRecord(root.data)?.plans
  const source =
    Array.isArray(root.plans) ? root.plans
    : Array.isArray(root.previews) ? root.previews
    : Array.isArray(nested) ? nested
    : []
  return source
    .map(coercePlan)
    .filter((plan): plan is ZcodeClaimPlan => plan !== undefined)
    .sort((a, b) => b.priority - a.priority || a.planId.localeCompare(b.planId))
}

function requireJwt(connection: ProviderConnection): string {
  const jwt = zcodeSessionJwt(connection)
  if (!jwt) {
    throw new ZcodeClaimError(
      "This account has no ZCode session; sign in to ZCode again.",
    )
  }
  if (zcodeJwtExpired(jwt)) {
    throw new ZcodeClaimError(
      "ZCode's sign-in has expired; add the account again to claim plans.",
      401,
    )
  }
  return jwt
}

interface BillingResponse {
  status: number
  body: Record<string, unknown>
}

async function billingRequest(
  connection: ProviderConnection,
  path: "preview" | "claim",
  init: RequestInit,
  signal: AbortSignal,
): Promise<BillingResponse> {
  const proxyUrl = getConnectionProxyUrl(connection)
  const suffix = path === "preview" ? previewQuery() : ""
  const response = await oauthFetch(
    `${BILLING_BASE}/billing/${path}${suffix}`,
    {
      ...init,
      signal,
      headers: {
        ...zcodeBillingHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    proxyUrl ? { proxyUrl } : undefined,
  )
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = (JSON.parse(text) as Record<string, unknown>) ?? {}
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

function previewQuery(): string {
  return (
    "?"
    + new URLSearchParams({
      app_version: ZCODE_APP_VERSION,
      platform: `${process.platform}-${process.arch}`,
    }).toString()
  )
}

/**
 * 拉取可领取套餐（按优先级降序）。上游 404 = 当前没有活动投放，返回空。
 */
export async function fetchZcodeClaimPlans(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ZcodeClaimPlan>> {
  const jwt = requireJwt(connection)
  const response = await billingRequest(
    connection,
    "preview",
    {
      method: "GET",
      headers: { authorization: `Bearer ${jwt}` },
    },
    signal ?? AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
  )
  if (response.status === 404) return []
  if (response.status === 401 || response.status === 403) {
    const text = JSON.stringify(response.body).toLowerCase()
    if (!text.includes("captcha") && !text.includes("verify")) {
      throw new ZcodeClaimError(FAIL_MESSAGES[401]!, 401)
    }
  }
  if (!response.status || response.status >= 500) {
    throw new ZcodeClaimError(
      `ZCode preview failed (HTTP ${response.status}).`,
      -1,
    )
  }
  const code = businessCode(response.body)
  if (code !== 0 && code !== 200) {
    throw failError(code, response.body)
  }
  return parseZcodeClaimPlans(response.body.data)
}

function planResult(
  body: Record<string, unknown>,
  planId: string,
  planName: string,
  grants: Array<ZcodeClaimGrant>,
): ZcodeClaimResult {
  const data = asRecord(body.data)
  const plan = asRecord(data?.plan)
  const ms = (value: unknown): number | undefined => {
    const seconds = asNum(value)
    return seconds !== undefined && seconds > 0 ?
        Math.round(seconds * 1000)
      : undefined
  }
  return {
    planId,
    planName,
    grants,
    startsAtMs: ms(plan?.starts_at),
    endsAtMs: ms(plan?.ends_at),
    serverTimeMs: ms(data?.server_time),
  }
}

/**
 * 领取一个套餐。planId 缺省时自动选优先级最高的可领套餐（先 preview）。
 * verifyParam 缺省时现场在 Chromium 里求验证码。
 */
export async function claimZcodePlan(
  connection: ProviderConnection,
  options: {
    planId?: string
    verifyParam?: string
    region?: string
    signal?: AbortSignal
  } = {},
): Promise<ZcodeClaimResult> {
  const jwt = requireJwt(connection)
  let planId = options.planId?.trim() ?? ""
  let planName = ""
  let grants: Array<ZcodeClaimGrant> = []
  if (!planId) {
    const plans = await fetchZcodeClaimPlans(connection, options.signal)
    if (plans.length === 0) {
      throw new ZcodeClaimError("There is no plan to claim right now.")
    }
    const best = plans[0]!
    planId = best.planId
    planName = best.name
    grants = best.grants
  }

  let verifyParam = options.verifyParam?.trim() ?? ""
  let region = options.region?.trim() ?? ""
  if (!verifyParam) {
    const token = await getZcodeVerifyParam({
      connection,
      signal: options.signal,
    })
    verifyParam = token.param
    region ||= token.region
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${jwt}`,
    "X-Aliyun-Captcha-Verify-Param": verifyParam,
    "X-Device-Mid": zcodeDeviceMid(),
  }
  if (region) headers["X-Aliyun-Captcha-Verify-Region"] = region

  const response = await billingRequest(
    connection,
    "claim",
    { method: "POST", headers, body: JSON.stringify({ plan_id: planId }) },
    options.signal ?? AbortSignal.timeout(CLAIM_TIMEOUT_MS),
  )

  const code = businessCode(response.body)
  if (code === 0 || code === 200) {
    if (!planName) planName = planId
    return planResult(response.body, planId, planName, grants)
  }
  if (code === 3007) invalidateZcodeVerifyParam()
  throw failError(code, response.body)
}

// ── 状态（connection.metadata.zcodeClaim） ──────────────────────

export function readZcodeClaimState(
  connection: ProviderConnection,
): ZcodeClaimState {
  const raw = asRecord(connection.metadata?.[CLAIM_STATE_KEY])
  if (!raw) return {}
  const state: ZcodeClaimState = {}
  if (typeof raw.checkedAt === "number") state.checkedAt = raw.checkedAt
  if (typeof raw.lastError === "string") state.lastError = raw.lastError
  if (typeof raw.lastErrorAt === "number") state.lastErrorAt = raw.lastErrorAt
  if (typeof raw.nextAttemptAt === "number") {
    state.nextAttemptAt = raw.nextAttemptAt
  }
  if (Array.isArray(raw.plans)) {
    state.plans = parseZcodeClaimPlans({ plans: raw.plans })
  }
  const holds = asRecord(raw.holds)
  if (holds) {
    state.holds = {}
    for (const [planId, value] of Object.entries(holds)) {
      const at = asNum(value)
      if (at !== undefined && at > 0) state.holds[planId] = at
    }
  }
  const lastClaim = asRecord(raw.lastClaim)
  if (lastClaim) {
    const planId = asStr(lastClaim.planId)
    const at = asNum(lastClaim.at)
    if (planId && at !== undefined) {
      state.lastClaim = {
        planId,
        planName: asStr(lastClaim.planName) || planId,
        at,
      }
    }
  }
  return state
}

export function writeZcodeClaimState(
  connection: ProviderConnection,
  state: ZcodeClaimState,
): void {
  connection.metadata ??= {}
  connection.metadata[CLAIM_STATE_KEY] = state
}

function activeHolds(
  state: ZcodeClaimState,
  now: number,
): Record<string, number> {
  const holds: Record<string, number> = {}
  for (const [planId, at] of Object.entries(state.holds ?? {})) {
    if (at > now) holds[planId] = at
  }
  return holds
}

/** zcode 连接是否值得打 billing（enabled / 凭据可用 / 有 JWT）。 */
export function isZcodeClaimCandidate(connection: ProviderConnection): boolean {
  if (connectionProvider(connection) !== "zcode") return false
  if (!connection.enabled) return false
  const credential = connection.credentials[0]
  if (!credential || credential.enabled === false) return false
  if (credential.status === "disabled" || credential.status === "auth_error") {
    return false
  }
  const jwt = zcodeSessionJwt(connection)
  return Boolean(jwt) && !zcodeJwtExpired(jwt)
}

// ── 自动领取轮 ──────────────────────────────────────────────────

let roundTask: Promise<void> | undefined

export function runZcodeClaimRound(now = Date.now()): Promise<void> {
  if (!getSystemSettings().zcodeAutoClaim) return Promise.resolve()
  if (roundTask) return roundTask
  const task = claimRound(now)
    .catch((error: unknown) => {
      logger.warn(
        `ZCode auto-claim round failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
    .finally(() => {
      roundTask = undefined
    })
  roundTask = task
  return task
}

async function claimRound(now: number): Promise<void> {
  const connections = listAccountManagedConnections().filter(
    isZcodeClaimCandidate,
  )
  if (connections.length === 0) return

  let changed = false
  for (const connection of connections) {
    const state = readZcodeClaimState(connection)
    if (state.nextAttemptAt !== undefined && now < state.nextAttemptAt) continue

    const holds = activeHolds(state, now)
    let plans: Array<ZcodeClaimPlan> = []
    try {
      plans = await fetchZcodeClaimPlans(connection)
      state.plans = plans
      state.checkedAt = Date.now()
      state.lastError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.checkedAt = Date.now()
      state.lastError = message
      state.lastErrorAt = Date.now()
      state.nextAttemptAt = Date.now() + ROUND_INTERVAL_MS
      state.holds = holds
      writeZcodeClaimState(connection, state)
      changed = true
      logger.warn(`ZCode preview failed for "${connection.name}": ${message}`)
      continue
    }

    let claimed = false
    for (const plan of plans) {
      if (holds[plan.planId]) continue
      try {
        const result = await claimZcodePlan(connection, { planId: plan.planId })
        claimed = true
        state.lastClaim = {
          planId: result.planId,
          planName: result.planName,
          at: Date.now(),
        }
        state.lastError = undefined
        logger.info(
          `Claimed ZCode plan "${result.planName}" for "${connection.name}"`,
        )
      } catch (error) {
        if (error instanceof ZcodeClaimError) {
          if (error.nextAtMs) {
            holds[plan.planId] = error.nextAtMs
          } else if (error.code === 1003) {
            // 已领过：不再记成错误，下一次 preview 也会消失。
          } else {
            state.lastError = error.message
            state.lastErrorAt = Date.now()
            logger.warn(
              `ZCode claim "${plan.planId}" for "${connection.name}" failed: ${error.message}`,
            )
          }
        } else {
          state.lastError =
            error instanceof Error ? error.message : String(error)
          state.lastErrorAt = Date.now()
        }
      }
    }

    state.holds = holds
    const earliestHold = Object.values(holds).sort((a, b) => a - b)[0]
    state.nextAttemptAt = Math.min(
      Date.now() + ROUND_INTERVAL_MS,
      earliestHold ?? Number.POSITIVE_INFINITY,
    )
    writeZcodeClaimState(connection, state)
    changed = true

    if (claimed) {
      try {
        await refreshManagedQuota(connection, { force: true })
      } catch (error) {
        logger.warn(
          `Could not refresh quota for "${connection.name}" after a claim: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  if (changed) await persistProviderConnections()
}

/** 测试用：清掉进行中的轮。 */
export async function __resetZcodeClaimRoundForTest(): Promise<void> {
  await roundTask
  roundTask = undefined
}
