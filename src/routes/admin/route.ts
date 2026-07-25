import { Hono } from "hono"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "~/lib/login-protection"
import {
  clearAdminSession,
  hasAdminRole,
  isAdminPasswordConfigured,
  isAuthorizedRequest,
  saveAdminPasswordToDb,
  setAdminSession,
  verifyAdminPassword,
} from "~/lib/request-auth"
import { getClientIp } from "~/lib/utils"

import { accountApiRoutes, accountFlowApiRoutes } from "./api/accounts"
import { dashboardApiRoutes } from "./api/dashboard"
import { guardApiRoutes } from "./api/guard"
import { logApiRoutes } from "./api/logs"
import { modelAliasApiRoutes } from "./api/model-aliases"
import { oauthApiRoutes } from "./api/oauth"
import { providerConnectionApiRoutes } from "./api/provider-connections"
import { providerApiRoutes } from "./api/providers"
import { quotaApiRoutes } from "./api/quota"
import { usageApiRoutes } from "./api/usage"
import { userApiRoutes } from "./api/users"

export const adminRoutes = new Hono()

// Serve static files (CSS/JS)
adminRoutes.get("/static/*", (c) => {
  const filePath = c.req.path.replace("/admin/static/", "")

  // Prevent path traversal - reject paths with .. or null bytes
  if (filePath.includes("..") || filePath.includes("\0")) {
    return c.notFound()
  }

  const allowedDirs = [
    resolve(process.cwd(), "pages"),
    resolve(process.cwd(), "..", "pages"),
    resolve(process.cwd(), "..", "..", "pages"),
  ]

  for (const baseDir of allowedDirs) {
    const fullPath = resolve(baseDir, filePath)

    // Ensure resolved path is within the allowed directory
    if (!fullPath.startsWith(baseDir)) {
      continue
    }

    try {
      const content = readFileSync(fullPath, "utf8")
      let contentType: string
      if (filePath.endsWith(".css")) {
        contentType = "text/css"
      } else if (filePath.endsWith(".js")) {
        contentType = "application/javascript"
      } else {
        contentType = "text/plain"
      }
      return c.body(content, 200, { "Content-Type": contentType })
    } catch {
      continue
    }
  }
  return c.notFound()
})

// Protect all /api/* routes with admin role check
adminRoutes.use("/api/*", async (c, next) => {
  // Admin routes must never be publicly accessible, even when no system-level
  // password has been configured yet. If no admin password is set, the login
  // page explains how to configure one.
  if (!hasAdminRole(c)) {
    return c.json(
      { error: "Forbidden. Admin role required to access this resource." },
      403,
    )
  }
  await next()
})

adminRoutes.route("/api/oauth", oauthApiRoutes)
adminRoutes.route("/api/accounts", accountApiRoutes)
adminRoutes.route("/api/account-flows", accountFlowApiRoutes)
adminRoutes.route("/api/providers", providerApiRoutes)
adminRoutes.route("/api/provider-connections", providerConnectionApiRoutes)
adminRoutes.route("/api/logs", logApiRoutes)
adminRoutes.route("/api/model-aliases", modelAliasApiRoutes)
adminRoutes.route("/api/quota", quotaApiRoutes)
adminRoutes.route("/api/usage", usageApiRoutes)
adminRoutes.route("/api/dashboard", dashboardApiRoutes)
adminRoutes.route("/api/users", userApiRoutes)
adminRoutes.route("/api/guard", guardApiRoutes)

// Serve a file from pages directory
function serveFile(filePath: string): string {
  // Prevent path traversal
  if (filePath.includes("..") || filePath.includes("\0")) {
    return `<h1>Invalid file path</h1>`
  }

  const allowedDirs = [
    resolve(process.cwd(), "pages"),
    resolve(process.cwd(), "..", "pages"),
    resolve(process.cwd(), "..", "..", "pages"),
  ]

  for (const baseDir of allowedDirs) {
    const fullPath = resolve(baseDir, filePath)

    // Ensure resolved path is within the allowed directory
    if (!fullPath.startsWith(baseDir)) {
      continue
    }

    try {
      return readFileSync(fullPath, "utf8")
    } catch {
      continue
    }
  }
  return `<h1>File not found: ${filePath}</h1>`
}

// Serve the SPA from pages/index.html
function serveSPA(): string {
  return serveFile("index.html")
}

// Serve the login page
function serveLoginPage(): string {
  return serveFile("login.html")
}

// Serve the initial setup page
function serveSetupPage(): string {
  return serveFile("setup.html")
}

// Route handlers
adminRoutes.get("/", (c) => {
  // The admin dashboard must always require authentication. Allowing public
  // access just because ADMIN_PASSWORD is not configured is a security risk.
  if (!hasAdminRole(c)) {
    return c.redirect(
      isAdminPasswordConfigured() ? "/admin/login" : "/admin/setup",
    )
  }
  return c.html(serveSPA())
})

adminRoutes.get("/login", (c) => {
  if (!isAdminPasswordConfigured()) {
    return c.redirect("/admin/setup")
  }

  if (isAuthorizedRequest(c)) {
    return c.redirect("/admin")
  }

  return c.html(serveLoginPage())
})

adminRoutes.post("/login", async (c) => {
  if (!isAdminPasswordConfigured()) {
    return c.json(
      { error: "Admin password is not configured. Use /admin/setup first." },
      400,
    )
  }

  const clientIp = getClientIp(c)

  const protection = checkLoginAllowed(clientIp)
  if (!protection.allowed) {
    if (protection.retryAfterSeconds) {
      c.header("Retry-After", String(protection.retryAfterSeconds))
    }
    return c.json(
      { error: protection.reason ?? "Too many login attempts." },
      429,
    )
  }

  let password: string | undefined
  let remember: boolean

  try {
    const contentType = c.req.header("content-type") ?? ""

    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Handle form data from login.html
      const body = await c.req.text()
      const params = new URLSearchParams(body)
      password = params.get("password") || undefined
      remember =
        params.get("remember") === "on" || params.get("remember") === "true"
    } else {
      // Handle JSON from API
      const payload = await c.req.json<{
        password?: string
        remember?: boolean
      }>()
      password = payload.password
      remember = Boolean(payload.remember)
    }
  } catch {
    return c.json({ error: "Invalid request payload." }, 400)
  }

  if (!password || !verifyAdminPassword(password)) {
    const failResult = await recordLoginFailure(clientIp)
    if (!failResult.allowed && failResult.retryAfterSeconds) {
      c.header("Retry-After", String(failResult.retryAfterSeconds))
    }
    const errorMsg = failResult.reason ?? "Invalid management password."
    const status = failResult.allowed ? 401 : 429
    return c.json({ error: errorMsg }, status)
  }

  recordLoginSuccess(clientIp)
  setAdminSession(c, remember)
  return c.json({ ok: true })
})

adminRoutes.get("/setup", (c) => {
  if (isAdminPasswordConfigured()) {
    return c.redirect("/admin/login")
  }
  return c.html(serveSetupPage())
})

adminRoutes.post("/setup", async (c) => {
  if (isAdminPasswordConfigured()) {
    return c.json({ error: "Admin password is already configured." }, 400)
  }

  let password: string | undefined

  try {
    const contentType = c.req.header("content-type") ?? ""

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await c.req.text()
      const params = new URLSearchParams(body)
      password = params.get("password") || undefined
    } else {
      const payload = await c.req.json<{ password?: string }>()
      password = payload.password
    }
  } catch {
    return c.json({ error: "Invalid request payload." }, 400)
  }

  if (!password || password.length < 6) {
    return c.json(
      { error: "Password must be at least 6 characters long." },
      400,
    )
  }

  saveAdminPasswordToDb(password)
  recordLoginSuccess(getClientIp(c))
  setAdminSession(c, true)
  return c.json({ ok: true })
})

adminRoutes.post("/logout", (c) => {
  clearAdminSession(c)
  return c.json({ ok: true })
})
