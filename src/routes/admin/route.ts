import { Hono } from "hono"

import {
  clearAdminSession,
  isAuthorizedRequest,
  setAdminSession,
} from "~/lib/request-auth"
import { state } from "~/lib/state"

export const adminRoutes = new Hono()

// Template functions - containing HTML templates, disabling line count rule
// eslint-disable-next-line max-lines-per-function
function renderAdminDashboardHtml(
  authStatus: string,
  hasAdminPasswordConfigured: boolean,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Copilot API Admin</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      :root {
        --bg-primary: #f5f5f7;
        --bg-secondary: #ffffff;
        --bg-tertiary: #eef1f6;
        --line: #e2e6ee;
        --text-primary: #1d1d1f;
        --text-secondary: #6e6e73;
        --text-tertiary: #8a8a8f;
        --accent-blue: #007aff;
        --accent-green: #34c759;
        --card-radius: 14px;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        background:
          radial-gradient(1200px 520px at 50% -25%, #ffffff 0%, #f7f8fb 58%, #eef1f6 100%),
          var(--bg-primary);
        color: var(--text-primary);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .container { width: 100%; max-width: 460px; }
      .header { text-align: center; margin-bottom: 30px; }
      .header-icon {
        width: 76px; height: 76px; margin: 0 auto 16px;
        background: linear-gradient(180deg, #ffffff 0%, #f2f4f9 100%);
        border: 1px solid var(--line);
        border-radius: 20px;
        display: flex; align-items: center; justify-content: center;
        font-size: 32px;
        box-shadow: 0 14px 36px rgba(15, 23, 42, 0.12), 0 1px 0 rgba(255, 255, 255, 0.8) inset;
      }
      h1 { font-size: 42px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px; }
      .subtitle { color: var(--text-secondary); font-size: 17px; }
      .status-badge {
        display: inline-block; margin-top: 14px; padding: 7px 14px;
        border-radius: 999px; font-size: 13px; font-weight: 600;
      }
      .status-badge.enabled { background: rgba(52, 199, 89, 0.16); color: #248a41; }
      .status-badge.disabled { background: rgba(142, 142, 147, 0.14); color: var(--text-secondary); }
      .menu-card {
        background: var(--bg-secondary);
        border: 1px solid var(--line);
        border-radius: var(--card-radius);
        overflow: hidden;
        box-shadow: 0 20px 48px rgba(15, 23, 42, 0.1), 0 2px 8px rgba(15, 23, 42, 0.06);
      }
      .menu-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 17px 20px; text-decoration: none; color: var(--text-primary);
        border-bottom: 1px solid #edf0f5;
        transition: background 0.2s ease, transform 0.2s ease;
      }
      .menu-item:last-child { border-bottom: none; }
      .menu-item:hover { background: #f8fbff; }
      .menu-item-left { display: flex; align-items: center; gap: 12px; }
      .menu-icon { font-size: 20px; }
      .menu-label { font-size: 15px; font-weight: 500; }
      .menu-arrow { color: var(--text-tertiary); font-size: 18px; }
      .logout-btn {
        width: 100%; margin-top: 16px; padding: 14px;
        background: #ffffff; color: #ff3b30;
        border: 1px solid var(--line);
        border-radius: var(--card-radius); font-size: 15px; font-weight: 600;
        cursor: pointer;
        box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
        transition: background 0.2s ease;
      }
      .logout-btn:hover { background: #fff5f5; }
      .no-auth {
        text-align: center;
        padding: 32px 20px;
        color: var(--text-secondary);
        font-size: 14px;
        background: linear-gradient(180deg, #ffffff 0%, #fafbfc 100%);
      }
      @media (max-width: 640px) {
        .container { max-width: 100%; }
        h1 { font-size: 34px; }
        .subtitle { font-size: 15px; }
      }

    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="header-icon">⚙️</div>
        <h1>Copilot API</h1>
        <p class="subtitle">Admin Dashboard</p>
        <span class="status-badge ${authStatus}">Auth ${authStatus}</span>
      </div>
      ${
        hasAdminPasswordConfigured ?
          `
      <div class="menu-card">
        <a href="/usage" class="menu-item">
          <div class="menu-item-left"><span class="menu-icon">📊</span><span class="menu-label">Usage Dashboard</span></div>
          <span class="menu-arrow">›</span>
        </a>
        <a href="/v1/models" class="menu-item">
          <div class="menu-item-left"><span class="menu-icon">🤖</span><span class="menu-label">Available Models</span></div>
          <span class="menu-arrow">›</span>
        </a>
      </div>
      <button id="logout" class="logout-btn">Sign Out</button>
      `
        : `
      <div class="menu-card"><div class="no-auth"><p>🔐 No password configured.</p><p style="margin-top:8px;">Set ADMIN_PASSWORD or --admin-password to enable auth.</p></div></div>
      `
      }
    </div>
    <script>
      document.getElementById("logout")?.addEventListener("click", async () => {
        await fetch("/admin/logout", { method: "POST" })
        window.location.href = "/admin/login"
      })
    </script>
  </body>
</html>`
}

// eslint-disable-next-line max-lines-per-function
function renderLoginPageHtml(message: string): string {
  const isWarning = message.includes("No management password")
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Copilot API Login</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      :root {
        --bg-primary: #ffffff;
        --bg-secondary: #f5f5f7;
        --bg-tertiary: #e5e5ea;
        --text-primary: #1d1d1f;
        --text-secondary: #6e6e73;
        --text-tertiary: #a1a1a6;
        --accent-blue: #007aff;
        --accent-green: #34c759;
        --accent-red: #ff3b30;
        --card-radius: 12px;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        background: var(--bg-primary); color: var(--text-primary);
        min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;
      }
      .container { width: 100%; max-width: 380px; }
      .header { text-align: center; margin-bottom: 32px; }
      .header-icon {
        width: 72px; height: 72px; margin: 0 auto 16px;
        background: linear-gradient(135deg, #f5f5f7 0%, #e5e5ea 100%);
        border-radius: 18px; display: flex; align-items: center; justify-content: center;
        font-size: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      }
      h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
      .subtitle { color: var(--text-secondary); font-size: 15px; }
      .warning-box {
        background: rgba(255, 159, 10, 0.15); border: 1px solid rgba(255, 159, 10, 0.3);
        border-radius: var(--card-radius); padding: 16px; margin-bottom: 24px; text-align: center;
      }
      .warning-box p { color: #ff9f0a; font-size: 14px; }
      .form-card { background: var(--bg-secondary); border-radius: var(--card-radius); padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
      .form-group { margin-bottom: 16px; }
      label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
      input {
        width: 100%; padding: 14px 16px; background: var(--bg-tertiary); border: none;
        border-radius: 10px; color: var(--text-primary); font-size: 16px; outline: none; transition: box-shadow 0.2s;
      }
      input:focus { box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.3); }
      input::placeholder { color: var(--text-tertiary); }
      .submit-btn {
        width: 100%; padding: 14px; background: var(--accent-blue); color: white; border: none;
        border-radius: 10px; font-size: 16px; font-weight: 500; cursor: pointer; transition: opacity 0.2s;
      }
      .submit-btn:hover { opacity: 0.9; }
      .error-msg { color: var(--accent-red); font-size: 14px; margin-top: 12px; text-align: center; min-height: 20px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="header-icon">🔐</div>
        <h1>Copilot API</h1>
        <p class="subtitle">Sign In</p>
      </div>
      ${
        isWarning ?
          `
      <div class="warning-box"><p>⚠️ ${message}</p></div>
      `
        : `
      <div class="form-card">
        <p style="color:var(--text-secondary);font-size:14px;margin-bottom:20px;text-align:center;">${message}</p>
        <form id="loginForm">
          <div class="form-group">
            <label for="password">Management Password</label>
            <input id="password" type="password" autocomplete="current-password" placeholder="Enter password" required />
          </div>
          <button type="submit" class="submit-btn">Sign In</button>
          <div id="error" class="error-msg"></div>
        </form>
      </div>
      `
      }
    </div>
    <script>
      const form = document.getElementById("loginForm")
      const error = document.getElementById("error")
      if (form) {
        form.addEventListener("submit", async (event) => {
          event.preventDefault()
          error.textContent = ""
          const password = document.getElementById("password").value
          const response = await fetch("/admin/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
          })
          if (!response.ok) {
            const data = await response.json().catch(() => null)
            error.textContent = data?.error ?? "Login failed"
            return
          }
          window.location.href = "/usage"
        })
      }
    </script>
  </body>
</html>`
}

// Route handlers
adminRoutes.get("/", (c) => {
  if (state.apiKey && !isAuthorizedRequest(c)) {
    return c.redirect("/admin/login")
  }
  const authStatus = state.apiKey ? "enabled" : "disabled"
  const hasAdminPasswordConfigured = Boolean(
    state.adminPassword ?? state.apiKey,
  )
  return c.html(
    renderAdminDashboardHtml(authStatus, hasAdminPasswordConfigured),
  )
})

adminRoutes.get("/login", (c) => {
  const hasAdminPasswordConfigured = Boolean(
    state.adminPassword ?? state.apiKey,
  )

  if (hasAdminPasswordConfigured && isAuthorizedRequest(c)) {
    return c.redirect("/usage")
  }

  const message =
    hasAdminPasswordConfigured ?
      "Enter the management password to access protected endpoints."
    : "No management password configured. Set ADMIN_PASSWORD (or --admin-password)."

  return c.html(renderLoginPageHtml(message))
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

  let payload: { password?: string }
  try {
    payload = await c.req.json<{ password?: string }>()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (!payload.password || payload.password !== configuredAdminPassword) {
    return c.json({ error: "Invalid management password." }, 401)
  }

  setAdminSession(c)
  return c.json({ ok: true })
})

adminRoutes.post("/logout", (c) => {
  clearAdminSession(c)
  return c.json({ ok: true })
})
