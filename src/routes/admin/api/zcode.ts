/**
 * ZCode 限时套餐领取 / 验证码浏览器的管理端接口。
 *
 *   GET  /api/zcode/captcha             浏览器状态（WebUI 展示安装/失败原因）
 *   POST /api/zcode/captcha/install     后台安装 Chromium（立即返回，状态轮询）
 *   POST /api/zcode/claims/:id/preview  实时拉一次可领套餐（免验证码）
 *   POST /api/zcode/claims/:id/claim    领取（缺 verifyParam 时现场求验证码）
 *
 * 领取只对 account-managed 的 zcode 连接开放；JWT 缺失/过期直接 400/401。
 */

import { Hono } from "hono"

import {
  accountManagedProvider,
  getMutableProviderConnection,
  isAccountManagedConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"
import { createLogger } from "~/lib/logger"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import {
  startZcodeBrowserInstall,
  zcodeBrowserStatus,
} from "~/services/zcode/browser"
import {
  claimZcodePlan,
  fetchZcodeClaimPlans,
  readZcodeClaimState,
  writeZcodeClaimState,
  ZcodeClaimError,
  type ZcodeClaimState,
} from "~/services/zcode/claim"
import { zcodeSessionJwt } from "~/services/zcode/start-plan"

export const zcodeApiRoutes = new Hono()

/** 子系统的日志：WebUI 的手动检查/领取也进「日志与诊断」。 */
const logger = createLogger("zcode")

function claimStatus(code: number): 400 | 409 | 502 {
  // 注意：ZCode 会话过期不是 admin 会话过期——回 401 会让 WebUI 的
  // API.request 把管理员踢回登录页，所以统一用 400 表达账号侧需要重新登录。
  if (code === 401) return 400
  if ([1001, 1002, 1003, 1004, 1005].includes(code)) return 409
  if (code === 3007 || code === 3001) return 400
  return 502
}

function claimErrorBody(error: unknown): {
  body: Record<string, unknown>
  status: 400 | 401 | 409 | 502
} {
  if (error instanceof ZcodeClaimError) {
    return {
      status: claimStatus(error.code),
      body: {
        error: error.message,
        code: error.code,
        ...(error.nextAtMs ? { nextAt: error.nextAtMs } : {}),
      },
    }
  }
  return {
    status: 502,
    body: { error: error instanceof Error ? error.message : String(error) },
  }
}

function requireZcodeConnection(id: string) {
  const connection = getMutableProviderConnection(id)
  if (
    !connection
    || !isAccountManagedConnection(connection)
    || accountManagedProvider(connection) !== "zcode"
  ) {
    return undefined
  }
  return connection
}

zcodeApiRoutes.get("/captcha", (c) => c.json({ browser: zcodeBrowserStatus() }))

zcodeApiRoutes.post("/captcha/install", (c) =>
  c.json({ browser: startZcodeBrowserInstall() }),
)

zcodeApiRoutes.post("/claims/:id/preview", async (c) => {
  const connection = requireZcodeConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Account not found." }, 404)
  if (!zcodeSessionJwt(connection)) {
    return c.json(
      { error: "This account has no ZCode session; sign in again." },
      400,
    )
  }
  try {
    const plans = await fetchZcodeClaimPlans(connection)
    const state = readZcodeClaimState(connection)
    const now = Date.now()
    const holds: Record<string, number> = {}
    for (const [planId, at] of Object.entries(state.holds ?? {})) {
      if (at > now) holds[planId] = at
    }
    const next: ZcodeClaimState = {
      ...state,
      checkedAt: now,
      plans,
      holds,
      lastError: undefined,
    }
    writeZcodeClaimState(connection, next)
    await persistProviderConnections()
    logger.info(
      `Checked ZCode claim plans for "${connection.name}": ${plans.length} available`,
    )
    return c.json({ plans, state: next })
  } catch (error) {
    const { body, status } = claimErrorBody(error)
    logger.warn(
      `ZCode claim check failed for "${connection.name}": ${String(
        body.error ?? "preview failed",
      )}`,
    )
    return c.json(body, status)
  }
})

zcodeApiRoutes.post("/claims/:id/claim", async (c) => {
  const connection = requireZcodeConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Account not found." }, 404)

  let body: Record<string, unknown> = {}
  try {
    const parsed = await readJsonBody(c.req.raw)
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const planId = typeof body.planId === "string" ? body.planId.trim() : ""
  const verifyParam =
    typeof body.verifyParam === "string" ? body.verifyParam.trim() : ""
  const region = typeof body.region === "string" ? body.region.trim() : ""

  const state = readZcodeClaimState(connection)
  try {
    const claim = await claimZcodePlan(connection, {
      ...(planId ? { planId } : {}),
      ...(verifyParam ? { verifyParam } : {}),
      ...(region ? { region } : {}),
    })
    const now = Date.now()
    const holds = { ...state.holds }
    delete holds[claim.planId]
    const next: ZcodeClaimState = {
      ...state,
      holds,
      lastClaim: {
        planId: claim.planId,
        planName: claim.planName,
        at: now,
      },
      lastError: undefined,
    }
    writeZcodeClaimState(connection, next)
    await persistProviderConnections()
    logger.info(
      `Claimed ZCode plan "${claim.planName}" for "${connection.name}"`,
    )
    // 领到的额度立刻反映到额度卡片（best effort）。
    try {
      await refreshManagedQuota(connection, { force: true })
    } catch {
      /* the claim succeeded; quota will catch up on the next tick */
    }
    return c.json({ claim, state: next })
  } catch (error) {
    const { body: errorBody, status } = claimErrorBody(error)
    logger.warn(
      `ZCode claim failed for "${connection.name}": ${String(
        errorBody.error ?? "claim failed",
      )}`,
    )
    const next: ZcodeClaimState = {
      ...state,
      lastError: String(errorBody.error ?? "claim failed"),
      lastErrorAt: Date.now(),
    }
    if (error instanceof ZcodeClaimError && error.nextAtMs) {
      const plan = planId || state.plans?.[0]?.planId
      if (plan) {
        next.holds = { ...state.holds, [plan]: error.nextAtMs }
      }
    }
    writeZcodeClaimState(connection, next)
    await persistProviderConnections()
    return c.json({ ...errorBody, state: next }, status)
  }
})
