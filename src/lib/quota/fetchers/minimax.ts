/**
 * MiniMax Code 配额拉取：Token Plan（订阅窗口）+ 积分（Credits 钱包）。
 *
 * 订阅窗口端点：`GET {api域}/v1/api/openplatform/coding_plan/remains`
 * （`base_resp.status_code !== 0` 表示凭证被拒/套餐不可用）。
 *
 * 但**没有订阅**不等于没有钱：积分（Credits）是独立的一笔余额，未订阅或订阅
 * 已到期的账号在 remains 上只会拿到 `2062 no active token plan subscription`，
 * 积分却照常可用（官方客户端在这种账号上展示的正是积分，端点见
 * `MINIMAX_MEMBERSHIP_INFO_PATH` 的说明）。所以 2062 不是失败，而是“换一笔钱
 * 来报”的信号：此时改读积分钱包，把余额当成可花额度返回，而不是把整张配额卡
 * 打成错误。
 *
 * 响应里 `model_remains[]` 每行带**两个窗口**：5 小时滚动窗口（`*_interval_*`）
 * 与周窗口（`*_weekly_*`）。三个必须照抄官方实现的细节：
 *
 * 1. `*_usage_count` 的语义是模糊的（老响应是“剩余”、新响应是“已用”）——
 *    用显式百分比 `*_remaining_percent` 消歧，否则进度条会反过来；
 * 2. 周窗口带显示倍率 `weekly_boost_permille`（百分比可超过 100%）；
 * 3. `status === 3` 通常表示“不限量”，但**两个总量都为 0 时**它表示
 *    “当前套餐不含该模型”，渲染成不限量会凭空许诺额度。
 *
 * 另外这个端点路径挂在 api 域上（不是 Messages 用的 agent 域），所以按区域
 * 逐个候选尝试；401/403 是**对凭证**的判定（每个 host 都一样），立刻停。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import {
  MINIMAX_CODING_PLAN_REMAINS_PATH,
  MINIMAX_MEMBERSHIP_INFO_PATH,
  MINIMAX_REQUEST_HEADERS,
  MINIMAX_USER_EXTRA_INFO_PATH,
} from "~/lib/quota/constants"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import {
  MINIMAX_REGIONS,
  MINIMAX_USER_AGENT,
  resolveMinimaxRegion,
} from "~/services/oauth/minimax"

interface MinimaxQuotaWindow {
  key: "interval" | "weekly"
  remainingPercent: number
  remaining?: number
  total?: number
  resetsAtMs?: number
  unlimited: boolean
}

interface MinimaxQuotaModel {
  name: string
  unlimited: boolean
  windows: Array<MinimaxQuotaWindow>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * 用显式百分比给模糊的 `*_usage_count` 消歧。
 *
 * 读数与百分比都对不上时返回 undefined，让该窗口退化成只看百分比，
 * 而不是凭空编一个数。
 */
function resolveWindowCounts(
  reported: number,
  total: number,
  remainingPercent: number | undefined,
): { remaining: number; total: number } | undefined {
  if (
    !Number.isFinite(reported)
    || !Number.isFinite(total)
    || total <= 0
    || reported < 0
    || reported > total
  ) {
    return undefined
  }
  let remaining = reported
  if (remainingPercent !== undefined && Number.isFinite(remainingPercent)) {
    const asRemaining = (reported / total) * 100
    const asUsed = ((total - reported) / total) * 100
    const distanceToRemaining = Math.abs(asRemaining - remainingPercent)
    const distanceToUsed = Math.abs(asUsed - remainingPercent)
    if (Math.min(distanceToRemaining, distanceToUsed) > 1) {
      return undefined
    }
    if (distanceToUsed < distanceToRemaining) {
      remaining = total - reported
    }
  }
  return { remaining, total }
}

/** 周窗口的显示倍率（permille → 倍率）。 */
function quotaBoostFactor(permille: unknown): number {
  return (
      typeof permille === "number" && Number.isFinite(permille) && permille > 0
    ) ?
      permille / 1000
    : 1
}

function buildWindow(input: {
  key: MinimaxQuotaWindow["key"]
  reportedCount: number
  total: number
  percent: number | undefined
  resetsAtMs: number | undefined
  boost: number
  unlimited: boolean
}): MinimaxQuotaWindow | undefined {
  const boost = input.boost
  // 没有任何可用数字的窗口（总量 0 且无显式百分比）不编造值：
  // 把它当成“剩余 0”会把一个不含该模型的套餐误判成“额度耗尽”。
  if (!input.unlimited && input.total <= 0 && input.percent === undefined) {
    return undefined
  }
  const remainingPercent =
    input.percent === undefined ?
      input.total > 0 ?
        Math.min(200, (input.reportedCount / input.total) * 100 * boost)
      : 0
    : Math.min(200, input.percent * boost)
  const counts =
    input.unlimited ? undefined : (
      resolveWindowCounts(input.reportedCount, input.total, input.percent)
    )

  return {
    key: input.key,
    remainingPercent,
    ...(counts === undefined ?
      {}
    : { remaining: counts.remaining, total: counts.total }),
    ...(input.resetsAtMs === undefined ? {} : { resetsAtMs: input.resetsAtMs }),
    unlimited: input.unlimited,
  }
}

/**
 * 解析 `coding_plan/remains` 文档。
 *
 * 只返回**一个**代表模型（`general` 桶 —— 它涵盖聊天/编码；video 之类的
 * 独立资源混进同一个条会没有意义）。
 */
export function parseMinimaxQuota(
  body: string,
):
  | { model: MinimaxQuotaModel; baseRespCode: number; baseRespMessage: string }
  | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (!record) return undefined

  const baseResp = asRecord(record.base_resp) ?? {}
  const baseRespCode = numberOr(baseResp.status_code, 0)
  const baseRespMessage =
    typeof baseResp.status_msg === "string" ? baseResp.status_msg : ""

  const rows = record.model_remains
  if (!Array.isArray(rows)) {
    return {
      model: { name: "general", unlimited: false, windows: [] },
      baseRespCode,
      baseRespMessage,
    }
  }

  const models: Array<MinimaxQuotaModel> = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (!row) continue
    const name =
      typeof row.model_name === "string" && row.model_name ?
        row.model_name
      : "general"
    const intervalTotal = numberOr(row.current_interval_total_count, 0)
    const weeklyTotal = numberOr(row.current_weekly_total_count, 0)
    const intervalStatus = numberOr(row.current_interval_status, 0)
    const weeklyStatus = numberOr(row.current_weekly_status, 0)
    // 两个总量都是 0：这一行不携带任何额度信息。
    // status=3 时它是“当前套餐不含该模型”（当不限量渲染会凭空许诺额度），
    // 其它 status 下它是未知窗口（当成“剩余 0”则会误判成额度耗尽）。
    if (intervalTotal === 0 && weeklyTotal === 0) {
      continue
    }
    const windows = [
      buildWindow({
        key: "interval",
        reportedCount: numberOr(row.current_interval_usage_count, 0),
        total: intervalTotal,
        percent: optionalNumber(row.current_interval_remaining_percent),
        resetsAtMs: optionalNumber(row.end_time),
        boost: 1,
        unlimited: intervalStatus === 3,
      }),
      buildWindow({
        key: "weekly",
        reportedCount: numberOr(row.current_weekly_usage_count, 0),
        total: weeklyTotal,
        percent: optionalNumber(row.current_weekly_remaining_percent),
        resetsAtMs: optionalNumber(row.weekly_end_time),
        boost: quotaBoostFactor(row.weekly_boost_permille),
        unlimited: weeklyStatus === 3,
      }),
    ].filter((window): window is MinimaxQuotaWindow => window !== undefined)
    if (windows.length === 0) continue
    models.push({
      name,
      unlimited: windows.every((window) => window.unlimited),
      windows,
    })
  }

  if (models.length === 0) {
    return {
      model: { name: "general", unlimited: false, windows: [] },
      baseRespCode,
      baseRespMessage,
    }
  }
  const primary = models.find((model) => model.name === "general") ?? models[0]!
  return { model: primary, baseRespCode, baseRespMessage }
}

/** MiniMax 用 2062 表达“这个账号当前没有生效的 Token Plan”，不是凭证被拒。 */
const MINIMAX_NO_TOKEN_PLAN_CODE = 2062

function isNoTokenPlan(code: number, message: string): boolean {
  if (code === MINIMAX_NO_TOKEN_PLAN_CODE) return true
  return /no active token plan/i.test(message)
}

/**
 * 积分金额（官方回的是字符串，可能带千分位）→ number。
 *
 * 与余额子系统同形：读不出数字就给 undefined，绝不编造 0——0 分是“钱花完了”
 * 的断言，只有上游真的这么说时才成立。
 */
function creditAmount(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const text = value.replaceAll(",", "").trim()
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

interface MinimaxCredits {
  /** 当前可花的积分总额。 */
  total: number
  /** 其中购买 / 赠送的部分（上游没给就留空）。 */
  purchased?: number
  free?: number
  hasTokenPlan: boolean
}

function creditsFromFields(input: {
  total: number | undefined
  purchased?: number
  free?: number
  hasTokenPlan: boolean
}): MinimaxCredits | undefined {
  if (input.total === undefined) return undefined
  return {
    total: input.total,
    ...(input.purchased === undefined ? {} : { purchased: input.purchased }),
    ...(input.free === undefined ? {} : { free: input.free }),
    hasTokenPlan: input.hasTokenPlan,
  }
}

/**
 * 解析 `get_membership_info` 的积分。
 *
 * 官方客户端的取值顺序照抄于此：`op_credit_summary.total_remaining_amount`
 * 优先（迁移到 OP 后的现行口径），只有摘要缺失时才退回顶层的
 * `opcredit_balance`（迁移后常年为 0 的老字段）。
 */
export function parseMinimaxCredits(body: string): MinimaxCredits | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const root = asRecord(parsed)
  if (!root) return undefined
  const summary = asRecord(root.op_credit_summary)
  return creditsFromFields({
    total:
      creditAmount(summary?.total_remaining_amount)
      ?? creditAmount(root.opcredit_balance),
    purchased: creditAmount(
      summary?.purchased_remaining_amount ?? summary?.purchased_credit,
    ),
    free: creditAmount(summary?.free_remaining_amount ?? summary?.free_credit),
    hasTokenPlan: root.has_token_plan === true,
  })
}

/** 解析 `get_user_extra_info`：积分挂在个人工作区（`workspace_type === 0`）上。 */
export function parseMinimaxWorkspaceCredits(
  body: string,
): MinimaxCredits | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const root = asRecord(parsed)
  const rows = root?.workspaces
  if (!Array.isArray(rows)) return undefined
  const workspaces = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== undefined)
  const personal =
    workspaces.find((row) => numberOr(row.workspace_type, -1) === 0)
    ?? workspaces[0]
  if (!personal) return undefined
  return creditsFromFields({
    total: creditAmount(personal.opcredit_balance),
    hasTokenPlan: personal.has_token_plan === true,
  })
}

interface MinimaxCreditReading {
  credits: MinimaxCredits
  /** 读到积分的 agent 域（诊断用）。 */
  host: string
}

/**
 * 读积分钱包。
 *
 * 先问 `get_membership_info`（摘要最全），它答不出数字时退回
 * `get_user_extra_info`。401/403 与 5xx 由调用方按“探测失败”处理，
 * 这里原样抛出，只有“答了、但没有可用数字”才返回 undefined。
 */
async function fetchMinimaxCredits(
  connection: ProviderConnection,
  region: ReturnType<typeof resolveMinimaxRegion>,
  signal?: AbortSignal,
): Promise<MinimaxCreditReading | undefined> {
  const host = MINIMAX_REGIONS[region].agent
  const headers = {
    ...MINIMAX_REQUEST_HEADERS,
    "Content-Type": "application/json",
    "User-Agent": MINIMAX_USER_AGENT,
  }

  for (const [path, parse] of [
    [MINIMAX_MEMBERSHIP_INFO_PATH, parseMinimaxCredits],
    [MINIMAX_USER_EXTRA_INFO_PATH, parseMinimaxWorkspaceCredits],
  ] as const) {
    const response = await executeUpstreamProxyCall(connection, {
      method: "POST",
      url: `${host}${path}`,
      headers,
      body: "{}",
      signal,
    })
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error(
        `MiniMax credit request rejected the credential (${response.statusCode})`,
      )
    }
    if (response.statusCode < 200 || response.statusCode >= 300) continue
    const credits = parse(response.body)
    if (credits) return { credits, host }
  }

  return undefined
}

function buildSnapshot(
  parsed: {
    model: MinimaxQuotaModel
    baseRespCode: number
    baseRespMessage: string
  },
  host: string,
  region: string,
  credits?: MinimaxCredits,
): QuotaSnapshot {
  const { model } = parsed
  const windows = model.windows
  const intervalWindow = windows.find((window) => window.key === "interval")
  // 取两个窗口里最紧的那个做头号百分比：任一窗口见底就该停止路由。
  const remainingPercents = windows
    .filter((window) => !window.unlimited)
    .map((window) => window.remainingPercent)
  const headline =
    remainingPercents.length > 0 ? Math.min(...remainingPercents) : 100

  return {
    fetchedAt: Date.now(),
    provider: "minimax",
    unlimited: model.unlimited || windows.length === 0,
    premiumInteractionsRemaining: headline,
    premiumInteractionsTotal: 100,
    ...(intervalWindow?.remaining === undefined ?
      {}
    : {
        chatRemaining: intervalWindow.remaining,
        chatTotal: intervalWindow.total,
      }),
    details: {
      minimax: {
        kind: "plan",
        model: model.name,
        host,
        region,
        windows,
        ...(credits === undefined ?
          {}
        : {
            credits: {
              total: credits.total,
              ...(credits.purchased === undefined ?
                {}
              : { purchased: credits.purchased }),
              ...(credits.free === undefined ? {} : { free: credits.free }),
            },
          }),
      },
    },
  }
}

/**
 * 无订阅时的快照：把积分当成可花额度。
 *
 * 不给 `premiumInteractionsRemaining`——积分不是某个窗口的占比，硬算百分比
 * 就是编数；余额由 `chatRemaining` 承载，`applyOAuthQuotaSnapshot` 的计数阈值
 * 因此在积分为 0 时判为耗尽（与官方客户端“0 分 = 没有可用资源”一致）。
 */
function buildCreditsSnapshot(
  reading: MinimaxCreditReading,
  region: string,
): QuotaSnapshot {
  const { credits } = reading
  return {
    fetchedAt: Date.now(),
    provider: "minimax",
    unlimited: false,
    chatRemaining: credits.total,
    details: {
      minimax: {
        kind: "credits",
        model: "general",
        host: reading.host,
        region,
        hasTokenPlan: credits.hasTokenPlan,
        windows: [],
        credits: {
          total: credits.total,
          ...(credits.purchased === undefined ?
            {}
          : { purchased: credits.purchased }),
          ...(credits.free === undefined ? {} : { free: credits.free }),
        },
      },
    },
  }
}

export async function fetchMinimaxQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "minimax") {
    throw new Error("fetchMinimaxQuota requires a MiniMax Code connection")
  }

  const region = resolveMinimaxRegion(connection)
  const hosts = MINIMAX_REGIONS[region].quotaHosts
  const failures: Array<string> = []
  // 上游明说“没有生效的订阅”：不是错误，转去读积分。
  let planMissing = false

  for (const host of hosts) {
    const response = await executeUpstreamProxyCall(connection, {
      method: "GET",
      url: `${host}${MINIMAX_CODING_PLAN_REMAINS_PATH}`,
      headers: { ...MINIMAX_REQUEST_HEADERS, "User-Agent": MINIMAX_USER_AGENT },
      signal,
    })

    // 401/403 是对“凭证”的判定，每个候选 host 结论相同 → 不浪费剩余探测。
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error(
        `MiniMax quota request rejected the credential (${response.statusCode})`,
      )
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      failures.push(`${host}: HTTP ${response.statusCode}`)
      continue
    }

    const parsed = parseMinimaxQuota(response.body)
    if (!parsed) {
      failures.push(`${host}: 响应不是 JSON`)
      continue
    }
    if (parsed.baseRespCode !== 0) {
      if (isNoTokenPlan(parsed.baseRespCode, parsed.baseRespMessage)) {
        planMissing = true
        break
      }
      // 其余非 0：凭证不被这个端点接受，换 host 结论相同，如实报错。
      throw new Error(
        `MiniMax quota request refused (${parsed.baseRespCode}): ${parsed.baseRespMessage || "unknown"}`,
      )
    }
    if (parsed.model.windows.length === 0) {
      // base_resp 为 0 但没有任何窗口 = 同样没有订阅（如 remains_percent 的
      // 空响应），也走积分。
      planMissing = true
      break
    }

    // 有订阅：顺带把积分读出来，订阅用完转扣积分时卡片能说清楚钱从哪来。
    // 读不到不影响计划窗口这条主结论。
    const credits = await fetchMinimaxCredits(connection, region, signal).catch(
      () => undefined,
    )
    return buildSnapshot(parsed, host, region, credits?.credits)
  }

  if (planMissing) {
    const reading = await fetchMinimaxCredits(connection, region, signal)
    if (reading) return buildCreditsSnapshot(reading, region)
    throw new Error(
      "MiniMax account has no active token plan and no readable credit balance",
    )
  }

  throw new Error(
    `MiniMax quota request failed on every candidate host (${failures.join("; ")})`,
  )
}
