import { Hono } from "hono"

import {
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  isTotpEnabled,
} from "~/lib/request-auth"
import { readJsonBody } from "~/lib/request-body"

export const totpApiRoutes = new Hono()

// GET /api/totp/status
totpApiRoutes.get("/status", (c) => {
  return c.json({ enabled: isTotpEnabled() })
})

// POST /api/totp/setup — returns a secret + otpauth URI (display once).
totpApiRoutes.post("/setup", (c) => {
  if (isTotpEnabled()) {
    return c.json({ error: "TOTP is already enabled." }, 409)
  }
  return c.json(beginTotpSetup())
})

// POST /api/totp/enable  { code }
totpApiRoutes.post("/enable", async (c) => {
  let body: { code?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  if (!body.code || !confirmTotpSetup(body.code)) {
    return c.json({ error: "Invalid verification code." }, 401)
  }
  return c.json({ ok: true })
})

// POST /api/totp/disable  { password }
totpApiRoutes.post("/disable", async (c) => {
  let body: { password?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  if (!body.password || !disableTotp(body.password)) {
    return c.json({ error: "Invalid management password." }, 401)
  }
  return c.json({ ok: true })
})
