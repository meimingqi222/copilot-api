import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { accountApiRoutes } from "~/routes/admin/api/accounts"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"

const originalTransport = process.env.COPILOT_API_CLAUDE_TRANSPORT

afterEach(() => {
  setClaudeCliTestHooks({})
  if (originalTransport === undefined) {
    delete process.env.COPILOT_API_CLAUDE_TRANSPORT
  } else {
    process.env.COPILOT_API_CLAUDE_TRANSPORT = originalTransport
  }
})

test.each([false, true])(
  "account listing reports server CLI presence (%s) without exposing its path",
  async (installed) => {
    setClaudeCliTestHooks({
      findBinary: () => (installed ? "/private/bin/claude" : undefined),
    })
    delete process.env.COPILOT_API_CLAUDE_TRANSPORT
    const response = await accountApiRoutes.request("/")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ claudeCli: { installed, httpForced: false } })
    expect(JSON.stringify(body)).not.toContain("/private/bin/claude")

    process.env.COPILOT_API_CLAUDE_TRANSPORT = " HTTP "
    const forced = await accountApiRoutes.request("/")
    expect(await forced.json()).toMatchObject({
      claudeCli: { installed, httpForced: true },
    })
  },
)

test("account card distinguishes missing CLI from HTTP and unknown detection state", () => {
  const view = runInNewContext(
    readFileSync("pages/js/views/accounts.js", "utf8") + "\naccountsView()",
    { ViewHelpers: {} },
  ) as {
    claudeCli: { installed: boolean; httpForced: boolean } | null
    claudeCliStatus(account: {
      settings?: { claudeTransport: string }
    }): string | null
  }
  expect(view.claudeCliStatus({})).toBeNull()
  view.claudeCli = { installed: false, httpForced: false }
  expect(view.claudeCliStatus({})).toBe("missing")
  expect(view.claudeCliStatus({ settings: { claudeTransport: "http" } })).toBe(
    "http",
  )
  view.claudeCli.installed = true
  expect(view.claudeCliStatus({})).toBe("installed")
  view.claudeCli = { installed: false, httpForced: true }
  expect(view.claudeCliStatus({ settings: { claudeTransport: "cli" } })).toBe(
    "httpForced",
  )
})
