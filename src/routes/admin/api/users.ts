import { Hono } from "hono"

import {
  createUser,
  deleteUser,
  resetApiKey,
  toPublicUser,
  updateUser,
} from "~/lib/users"
import { state } from "~/lib/state"

export const userApiRoutes = new Hono()

userApiRoutes.get("/", (c) => {
  return c.json({ users: state.users.map(toPublicUser) })
})

userApiRoutes.post("/", async (c) => {
  let body: { username?: string; quotaLimit?: number; role?: "admin" | "user" }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (!body.username || typeof body.username !== "string") {
    return c.json({ error: "username is required." }, 400)
  }

  const userWithKey = await createUser(body.username, body.quotaLimit ?? 0, body.role ?? "user")
  return c.json({ user: userWithKey }, 201)
})

userApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  let body: { username?: string; quotaLimit?: number; enabled?: boolean; role?: "admin" | "user" }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const updated = await updateUser(id, body)
  if (!updated) return c.json({ error: "User not found." }, 404)
  return c.json({ user: toPublicUser(updated) })
})

userApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const deleted = await deleteUser(id)
  if (!deleted) return c.json({ error: "User not found." }, 404)
  return c.json({ ok: true })
})

userApiRoutes.post("/:id/reset-key", async (c) => {
  const id = c.req.param("id")
  const newKey = await resetApiKey(id)
  if (!newKey) return c.json({ error: "User not found." }, 404)
  return c.json({ apiKey: newKey })
})

