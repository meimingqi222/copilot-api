/**
 * 管理端会话跨进程重启保持（回归测试）。
 *
 * 会话原先只存在内存里：服务一重启，浏览器那张 cookie 就永远对不上，用户被
 * 静默登出。若此时正在走 OAuth 重新认证，页面 poll 会拿到 403、流程又占着
 * provider 互斥，于是彻底卡死（线上实测）。
 *
 * cookie 自身生命周期是 12h（remember 更长），落盘才与之一致。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  ADMIN_SESSION_COOKIE,
  clearAdminSession,
  hasAdminRole,
  setAdminSession,
} from "~/lib/request-auth"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

import {
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalAdminPassword = state.adminPassword
const originalApiKey = state.legacyApiKey

interface FakeContext {
  req: {
    url: string
    raw: Request
    header: (name: string) => string | undefined
  }
  header: (name: string, value: string) => void
  cookies: string[]
}

/**
 * 最小 Hono Context 替身：hono 的 getCookie 走 `c.req.raw.headers.get("Cookie")`，
 * setCookie/deleteCookie 走 `c.header("Set-Cookie", …)`，其余只需 req.url。
 */
function fakeContext(cookieHeader?: string): FakeContext {
  const out: string[] = []
  const headers = new Headers()
  if (cookieHeader) headers.set("cookie", cookieHeader)
  const raw = new Request("http://localhost/admin/login", { headers })
  return {
    req: {
      url: raw.url,
      raw,
      header: (name: string) => headers.get(name) ?? undefined,
    },
    header: (name: string, value: string) => {
      if (name.toLowerCase() === "set-cookie") out.push(value)
    },
    cookies: out,
  }
}

function adminSessionTokenFrom(ctx: FakeContext): string | undefined {
  const header = ctx.cookies.find((value) =>
    value.startsWith(`${ADMIN_SESSION_COOKIE}=`),
  )
  return header?.split(";")[0]?.split("=")[1]
}

/** hasAdminRole 只需要 req.header（API key 路径已由 state 置空）。 */
function requestWithCookie(token: string) {
  return fakeContext(`${ADMIN_SESSION_COOKIE}=${token}`) as never
}

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.deleteConfig("admin_session")
  clearAdminAuth()
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = "scrypt$test$placeholder"
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  statsStore.deleteConfig("admin_session")
  state.adminPassword = originalAdminPassword
  state.legacyApiKey = originalApiKey
  clearAdminAuth()
  clearAdminPasswordConfig()
})

describe("管理端会话持久化", () => {
  test("重启后同一张 cookie 仍然有效（不再被静默登出）", () => {
    const login = fakeContext()
    setAdminSession(login as never)

    const token = adminSessionTokenFrom(login)
    expect(token).toBeTruthy()

    // 模拟进程重启：内存态清空（旧实现到这里就永久登出了）
    state.adminSessionToken = undefined
    state.adminSessionExpiresAt = undefined
    expect(hasAdminRole(requestWithCookie(token!))).toBe(true)
  })

  test("登出会同时清掉落盘会话", () => {
    const login = fakeContext()
    setAdminSession(login as never)
    const token = adminSessionTokenFrom(login)!

    clearAdminSession(fakeContext() as never)
    state.adminSessionToken = undefined
    state.adminSessionExpiresAt = undefined

    expect(statsStore.getConfig("admin_session")).toBeUndefined()
    expect(hasAdminRole(requestWithCookie(token))).toBe(false)
  })

  test("过期的落盘会话不会被恢复", () => {
    const login = fakeContext()
    setAdminSession(login as never)
    const token = adminSessionTokenFrom(login)!

    // 直接把落盘会话改成已过期，再模拟重启
    statsStore.setConfig(
      "admin_session",
      JSON.stringify({ token, expiresAt: Date.now() - 1 }),
    )
    state.adminSessionToken = undefined
    state.adminSessionExpiresAt = undefined

    expect(hasAdminRole(requestWithCookie(token))).toBe(false)
    expect(statsStore.getConfig("admin_session")).toBeUndefined()
  })

  test("内存态仍在时优先走内存（测试里的 setupAdminAuth 依旧有效）", () => {
    setupAdminAuth()
    expect(hasAdminRole(requestWithCookie("test-admin-session-token"))).toBe(
      true,
    )
  })
})
