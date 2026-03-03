import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { Hono } from "hono"

import {
  clearAdminSession,
  isAuthorizedRequest,
  setAdminSession,
} from "~/lib/request-auth"
import { state } from "~/lib/state"

import { accountApiRoutes } from "./api/accounts"
import { dashboardApiRoutes } from "./api/dashboard"
import { logApiRoutes } from "./api/logs"
import { quotaApiRoutes } from "./api/quota"
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
      const content = readFileSync(fullPath, "utf-8")
      const contentType = filePath.endsWith(".css")
        ? "text/css"
        : filePath.endsWith(".js")
          ? "application/javascript"
          : "text/plain"
      return c.body(content, 200, { "Content-Type": contentType })
    } catch {
      continue
    }
  }
  return c.notFound()
})

// Protect all /api/* routes with admin session
adminRoutes.use("/api/*", async (c, next) => {
  if (!isAuthorizedRequest(c)) {
    return c.json({ error: "Unauthorized. Admin session required." }, 401)
  }
  await next()
})

adminRoutes.route("/api/users", userApiRoutes)
adminRoutes.route("/api/accounts", accountApiRoutes)
adminRoutes.route("/api/logs", logApiRoutes)
adminRoutes.route("/api/quota", quotaApiRoutes)
adminRoutes.route("/api/dashboard", dashboardApiRoutes)



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
      return readFileSync(fullPath, "utf-8")
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
  if (state.apiKey && !isAuthorizedRequest(c)) {
    return c.redirect("/admin/login")
  }
  return c.html(serveSPA())
})

adminRoutes.get("/login", (c) => {
  const hasAdminPasswordConfigured = Boolean(
    state.adminPassword ?? state.apiKey,
  )

  if (hasAdminPasswordConfigured && isAuthorizedRequest(c)) {
    return c.redirect("/admin")
  }

  const message =
    hasAdminPasswordConfigured ?
      undefined
    : "No management password configured. Set ADMIN_PASSWORD (or --admin-password)."

  return c.html(serveLoginPage(message))
})

adminRoutes.post("/login", async (c) => {
  const configuredAdminPassword = state.adminPassword ?? state.apiKey

  if (!configuredAdminPassword) {
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

  if (!password || password !== configuredAdminPassword) {
    return c.json({ error: "Invalid management password." }, 401)
  }

  setAdminSession(c)
  return c.json({ ok: true })
})

adminRoutes.post("/logout", (c) => {
  clearAdminSession(c)
  return c.json({ ok: true })
})
