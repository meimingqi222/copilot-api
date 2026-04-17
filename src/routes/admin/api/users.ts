import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  createUser,
  deleteUser,
  resetApiKey,
  toPublicUser,
  updateUser,
} from "~/lib/users"

export const userApiRoutes = new Hono()

userApiRoutes.get("/", (c) => {
  return c.json({
    users: state.users.map((u) => toPublicUser(u)),
  })
})

userApiRoutes.post("/", async (c) => {
  let body: {
    username?: string
    quotaLimit?: number
    role?: "admin" | "user"
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const username = body.username?.trim()
  if (!username) {
    return c.json({ error: "Username is required." }, 400)
  }

  const existing = state.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  )
  if (existing) {
    return c.json({ error: "Username already exists." }, 409)
  }

  const role = body.role === "admin" ? "admin" : "user"
  const userWithKey = await createUser(username, body.quotaLimit ?? 0, role)

  return c.json({
    user: toPublicUser(userWithKey),
    apiKey: userWithKey.apiKey,
  })
})

userApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")

  let body: {
    username?: string
    quotaLimit?: number
    enabled?: boolean
    role?: "admin" | "user"
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const patch: Parameters<typeof updateUser>[1] = {}
  if (body.username !== undefined) patch.username = body.username.trim()
  if (body.quotaLimit !== undefined) patch.quotaLimit = body.quotaLimit
  if (body.enabled !== undefined) patch.enabled = body.enabled
  if (body.role !== undefined) patch.role = body.role

  const user = await updateUser(id, patch)
  if (!user) return c.json({ error: "User not found." }, 404)

  return c.json({ user: toPublicUser(user) })
})

userApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const ok = await deleteUser(id)
  if (!ok) return c.json({ error: "User not found." }, 404)
  return c.json({ ok: true })
})

userApiRoutes.post("/:id/reset-key", async (c) => {
  const id = c.req.param("id")
  const newKey = await resetApiKey(id)
  if (!newKey) return c.json({ error: "User not found." }, 404)
  return c.json({ apiKey: newKey })
})
