import { Hono } from "hono"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  clearAdminSession,
  hasAdminRole,
  isAuthorizedRequest,
  setAdminSession,
  verifyAdminPassword,
} from "~/lib/request-auth"
import { state } from "~/lib/state"

import { accountApiRoutes, accountFlowApiRoutes } from "./api/accounts"
import { dashboardApiRoutes } from "./api/dashboard"
import { guardApiRoutes } from "./api/guard"
import { logApiRoutes } from "./api/logs"
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
  // Multi-user mode always requires auth
  const hasMultiUserMode = state.users.length > 0
  // Single-user mode requires auth if system-level auth is configured
  const hasSystemAuth = Boolean(state.legacyApiKey || state.adminPassword)
  // Require auth in multi-user mode OR if system auth is configured
  if ((hasMultiUserMode || hasSystemAuth) && !hasAdminRole(c)) {
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
function serveLoginPage(message?: string): string {
  let html = serveFile("login.html")
  // If there's a message, inject it as a hidden element for the app to read
  if (message) {
    const injection = `<div id="server-message" data-message="${encodeURIComponent(message)}" style="display:none"></div>`
    html = html.replace("</body>", `${injection}</body>`)
  }
  return html
}

// Route handlers
adminRoutes.get("/", (c) => {
  // Multi-user mode always requires auth
  const hasMultiUserMode = state.users.length > 0
  // Single-user mode requires auth if system-level auth is configured
  const hasSystemAuth = Boolean(state.legacyApiKey || state.adminPassword)
  // Require auth in multi-user mode OR if system auth is configured
  if ((hasMultiUserMode || hasSystemAuth) && !hasAdminRole(c)) {
    return c.redirect("/admin/login")
  }
  return c.html(serveSPA())
})

adminRoutes.get("/login", (c) => {
  const hasAdminPasswordConfigured = Boolean(
    state.adminPassword ?? state.legacyApiKey,
  )

  if (hasAdminPasswordConfigured && isAuthorizedRequest(c)) {
    return c.redirect("/admin")
  }

  const message =
    hasAdminPasswordConfigured ? undefined : (
      "No management password configured. Set ADMIN_PASSWORD (or --admin-password)."
    )

  return c.html(serveLoginPage(message))
})

adminRoutes.post("/login", async (c) => {
  if (!state.adminPassword && !state.legacyApiKey) {
    return c.json(
      {
        error:
          "Admin password is not configured. Set ADMIN_PASSWORD (or --admin-password).",
      },
      400,
    )
  }

  let password: string | undefined

  try {
    const contentType = c.req.header("content-type") || ""

    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Handle form data from login.html
      const body = await c.req.text()
      const params = new URLSearchParams(body)
      password = params.get("password") || undefined
    } else {
      // Handle JSON from API
      const payload = await c.req.json<{ password?: string }>()
      password = payload.password
    }
  } catch {
    return c.json({ error: "Invalid request payload." }, 400)
  }

  if (!password || !verifyAdminPassword(password)) {
    return c.json({ error: "Invalid management password." }, 401)
  }

  setAdminSession(c)
  return c.json({ ok: true })
})

adminRoutes.post("/logout", (c) => {
  clearAdminSession(c)
  return c.json({ ok: true })
})
