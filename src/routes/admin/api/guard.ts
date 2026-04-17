import { Hono } from "hono"

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
  let body: { value?: string; type?: "ip" | "ua"; reason?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const value = body.value?.trim()
  if (!value) {
    return c.json({ error: "value is required." }, 400)
  }
  const type = body.type === "ua" ? "ua" : "ip"

  const entry = await addBlacklistEntry({ value, type, reason: body.reason })
  return c.json({ entry })
})

// DELETE /api/guard/blacklist  { value, type }
guardApiRoutes.delete("/blacklist", async (c) => {
  let body: { value?: string; type?: "ip" | "ua" }
  try {
    body = await c.req.json()
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
    body = await c.req.json()
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
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const pattern = body.pattern?.trim()
  if (!pattern) return c.json({ error: "pattern is required." }, 400)
  const ok = await removeUaWhitelistPattern(pattern)
  if (!ok) return c.json({ error: "Pattern not found." }, 404)
  return c.json({ ok: true })
})
