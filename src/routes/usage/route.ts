import type { ContentfulStatusCode } from "hono/utils/http-status"

import { Hono } from "hono"

import { HTTPError } from "~/lib/error"
import { isAuthorizedRequest } from "~/lib/request-auth"
import { state } from "~/lib/state"
import {
  getCopilotUsage,
  type CopilotUsageResponse,
  type QuotaDetail,
} from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

type QuotaKey = "premium_interactions" | "chat" | "completions"

interface RenderQuota {
  title: string
  icon: string
  kind: "premium" | "chat" | "completions"
  data?: QuotaDetail
}

const quotaCards: Array<{ key: QuotaKey; title: string; icon: string }> = [
  { key: "premium_interactions", title: "Premium Interactions", icon: "💎" },
  { key: "chat", title: "Chat", icon: "💬" },
  { key: "completions", title: "Completions", icon: "✨" },
]

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "N/A"
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function renderQuotaCard(quota: RenderQuota): string {
  if (!quota.data) {
    return `
      <article class="quota-card">
        <div class="quota-top">
          <div class="quota-name"><span class="icon ${quota.kind}">${quota.icon}</span>${quota.title}</div>
          <span class="badge na">N/A</span>
        </div>
        <p class="subtle">No data available</p>
      </article>
    `
  }

  const entitlement = toNumber(quota.data.entitlement) ?? 0
  const remaining = toNumber(quota.data.remaining) ?? 0
  const unlimited = quota.data.unlimited
  const used = Math.max(0, entitlement - remaining)
  const percentRemaining =
    toNumber(quota.data.percent_remaining)
    ?? (entitlement > 0 ? (remaining / entitlement) * 100 : 0)
  const percentUsed = entitlement > 0 ? (used / entitlement) * 100 : 0

  let badgeClass = "ok"
  let badgeText = `${Math.max(0, percentRemaining).toFixed(1)}% left`
  if (unlimited) {
    badgeClass = "unlimited"
    badgeText = "Unlimited"
  } else if (percentRemaining < 20) {
    badgeClass = "danger"
  } else if (percentRemaining < 50) {
    badgeClass = "warn"
  }

  let progressClass = "ok"
  if (percentRemaining < 20) {
    progressClass = "danger"
  } else if (percentRemaining < 50) {
    progressClass = "warn"
  }

  return `
    <article class="quota-card">
      <div class="quota-top">
        <div class="quota-name"><span class="icon ${quota.kind}">${quota.icon}</span>${quota.title}</div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      ${
        unlimited ? "" : (
          `
        <div class="progress"><div class="progress-fill ${progressClass}" style="width:${Math.min(100, Math.max(0, percentUsed)).toFixed(1)}%"></div></div>
        <div class="quota-meta">
          <span><strong>${formatNumber(used)}</strong> used</span>
          <span>${formatNumber(remaining)} / ${formatNumber(entitlement)}</span>
        </div>
      `
        )
      }
    </article>
  `
}

// eslint-disable-next-line max-lines-per-function
function renderUsagePage(usage: CopilotUsageResponse): string {
  const snapshots = usage.quota_snapshots ?? {}
  const plan = escapeHtml(usage.copilot_plan || "N/A")
  const resetDate = escapeHtml(usage.quota_reset_date || "N/A")
  const accessType = escapeHtml(usage.access_type_sku || "N/A")

  const cardsHtml = quotaCards
    .map(({ key, title, icon }) =>
      renderQuotaCard({
        title,
        icon,
        kind: key === "premium_interactions" ? "premium" : key,
        data: snapshots[key],
      }),
    )
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Copilot Usage</title>
  <style>
    :root {
      --bg: #eef1f6;
      --surface: #ffffff;
      --surface-soft: #f8f9fc;
      --line: #dce2ec;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --blue: #0071e3;
      --green: #34c759;
      --orange: #ff9f0a;
      --red: #ff3b30;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
      padding: 28px 24px;
    }
    .wrap { max-width: 1020px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 38px; letter-spacing: -0.03em; }
    .desc { margin: 0 0 24px; color: var(--muted); font-size: 15px; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .stat {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px 16px;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { margin-top: 8px; font-size: 18px; font-weight: 600; }
    .section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.1), 0 1px 0 rgba(255, 255, 255, 0.8) inset;
    }
    .section h2 { margin: 0 0 16px; font-size: 20px; }
    .quota-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .quota-card {
      background: linear-gradient(180deg, #ffffff 0%, var(--surface-soft) 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 6px 16px rgba(15, 23, 42, 0.06);
    }
    .quota-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .quota-name { font-size: 15px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
    .icon { width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: #ecf5ff; }
    .icon.premium { background: #fff6e8; }
    .icon.chat { background: #ecf5ff; }
    .icon.completions { background: #eefaf0; }
    .badge { font-size: 12px; padding: 4px 8px; border-radius: 999px; }
    .badge.ok { color: var(--green); background: rgba(52, 199, 89, 0.14); }
    .badge.warn { color: var(--orange); background: rgba(255, 159, 10, 0.14); }
    .badge.danger { color: var(--red); background: rgba(255, 59, 48, 0.14); }
    .badge.unlimited { color: var(--blue); background: rgba(0, 113, 227, 0.14); }
    .badge.na { color: var(--muted); background: rgba(110, 110, 115, 0.12); }
    .progress { height: 8px; background: #ececf0; border-radius: 999px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 999px; }
    .progress-fill.ok { background: var(--green); }
    .progress-fill.warn { background: var(--orange); }
    .progress-fill.danger { background: var(--red); }
    .quota-meta { display: flex; justify-content: space-between; margin-top: 10px; font-size: 13px; color: var(--muted); }
    .subtle { color: var(--muted); margin: 0; font-size: 13px; }
    .actions { margin-top: 16px; display: flex; gap: 12px; }
    .btn {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 14px;
      color: var(--text);
      text-decoration: none;
      background: #fff;
      transition: background 0.2s ease;
    }
    .btn:hover { background: #f7f9fc; }
    .btn.primary { background: var(--blue); color: #fff; border-color: var(--blue); }
    .btn.primary:hover { background: #0077ed; }
    @media (max-width: 900px) {
      .stats, .quota-grid { grid-template-columns: 1fr; }
      body { padding: 20px 16px; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Copilot Usage & Quotas</h1>
    <p class="desc">Local dashboard for current account usage.</p>

    <section class="stats">
      <article class="stat"><div class="label">Plan</div><div class="value">${plan}</div></article>
      <article class="stat"><div class="label">Reset Date</div><div class="value">${resetDate}</div></article>
      <article class="stat"><div class="label">Access</div><div class="value">${accessType}</div></article>
    </section>

    <section class="section">
      <h2>Quota Details</h2>
      <div class="quota-grid">${cardsHtml}</div>
      <div class="actions">
        <a class="btn primary" href="/usage">Refresh</a>
        <a class="btn" href="/admin">Back to Admin</a>
      </div>
    </section>
  </main>
</body>
</html>`
}

function renderErrorPage(message: string, details?: string): string {
  const safeMessage = escapeHtml(message)
  const safeDetails = escapeHtml(
    details ?? "Could not fetch Copilot usage information.",
  )

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Usage Error</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      background: #fff;
      color: #1d1d1f;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      width: min(560px, 100%);
      background: #f5f5f7;
      border: 1px solid #e5e5ea;
      border-radius: 16px;
      padding: 24px;
      text-align: center;
    }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { color: #6e6e73; margin: 0 0 12px; }
    code { background: #fff; border: 1px solid #e5e5ea; border-radius: 6px; padding: 2px 6px; }
    .actions { margin-top: 18px; display: flex; justify-content: center; gap: 10px; }
    a {
      text-decoration: none;
      border: 1px solid #e5e5ea;
      border-radius: 10px;
      padding: 10px 14px;
      color: #1d1d1f;
      background: #fff;
    }
  </style>
</head>
<body>
  <section class="card">
    <h1>${safeMessage}</h1>
    <p>${safeDetails}</p>
    <div class="actions">
      <a href="/usage">Try Again</a>
      <a href="/admin">Back to Admin</a>
    </div>
  </section>
</body>
</html>`
}

usageRoute.get("/", async (c) => {
  if (state.apiKey && !isAuthorizedRequest(c)) {
    return c.redirect("/admin/login")
  }

  const acceptHeader = c.req.header("accept")
  const wantsJson = acceptHeader?.includes("application/json")

  try {
    const usage = await getCopilotUsage()
    if (wantsJson) return c.json(usage)

    return c.html(renderUsagePage(usage))
  } catch (error) {
    if (error instanceof HTTPError) {
      const status = error.response.status
      const errorText = await error.response.clone().text()

      if (wantsJson) {
        return c.json(
          { error: errorText || "Failed to fetch Copilot usage" },
          status as ContentfulStatusCode,
        )
      }

      const details =
        status === 401 ?
          "GitHub authentication is invalid or expired. Re-run login with `bun run dev -- auth` and restart the server."
        : `GitHub returned ${status}. ${errorText || "Please retry."}`

      return c.html(
        renderErrorPage("Failed to Load Usage Data", details),
        status as ContentfulStatusCode,
      )
    }

    if (wantsJson) {
      return c.json({ error: "Failed to fetch Copilot usage" }, 500)
    }

    let details = "Unexpected error while loading usage data. Please retry."
    if (error instanceof Error) {
      details = `Unexpected error: ${error.message}`
    }

    return c.html(renderErrorPage("Failed to Load Usage Data", details), 500)
  }
})
