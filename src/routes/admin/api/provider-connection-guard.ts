/**
 * Provider connection 路由守卫:拒绝通过外部 provider API 操作
 * account-managed connection(*-native protocol)。
 *
 * 拆分自 provider-connections.ts 以满足行数限制。
 */
import type { Hono } from "hono"

import {
  getProviderConnection,
  isAccountManagedConnection,
} from "~/lib/provider-connections"

const GUARD_ERROR = {
  error:
    "This connection is managed by the account system. Use the accounts API instead.",
} as const

/**
 * 在 /:id 和 /:id/* 路由上挂载守卫中间件。
 * account-managed connection 只能通过 /admin/api/accounts 路径管理。
 * 判别器用 protocol 派生,T5.2.5 后仍然有效。
 */
export function mountConnectionGuard(routes: Hono): void {
  routes.use("/:id/*", async (c, next) => {
    const conn = getProviderConnection(c.req.param("id"))
    if (conn && isAccountManagedConnection(conn)) {
      return c.json(GUARD_ERROR, 403)
    }
    await next()
  })
  routes.use("/:id", async (c, next) => {
    const conn = getProviderConnection(c.req.param("id"))
    if (conn && isAccountManagedConnection(conn)) {
      return c.json(GUARD_ERROR, 403)
    }
    await next()
  })
}
