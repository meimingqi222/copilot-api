import { describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { applyConnectionPatchToAccount } from "~/lib/account-adapter"
import { getGitHubToken } from "~/lib/accounts"
import { parseBodyToPatch } from "~/routes/admin/api/account-update"

function makeCopilotAccount(): Account {
  return {
    id: "copilot-1",
    label: "copilot-test",
    provider: "copilot",
    credentials: { githubToken: "ghp_old" },
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
  }
}

describe("parseBodyToPatch", () => {
  test("copilot: maps credentials.githubToken to credentialValue", () => {
    const account = makeCopilotAccount()
    const patch = parseBodyToPatch(account, {
      credentials: { githubToken: "ghp_new" },
    })
    applyConnectionPatchToAccount(account, patch)
    expect(getGitHubToken(account)).toBe("ghp_new")
  })

  test("copilot: maps top-level githubToken to credentialValue", () => {
    const account = makeCopilotAccount()
    const patch = parseBodyToPatch(account, { githubToken: "ghp_top" })
    applyConnectionPatchToAccount(account, patch)
    expect(getGitHubToken(account)).toBe("ghp_top")
  })

  test("copilot: ignores githubToken when not present in body", () => {
    const account = makeCopilotAccount()
    const patch = parseBodyToPatch(account, { label: "renamed" })
    applyConnectionPatchToAccount(account, patch)
    expect(getGitHubToken(account)).toBe("ghp_old")
    expect(account.label).toBe("renamed")
  })

  test("codebuff: does not treat githubToken as credential", () => {
    const account: Account = {
      id: "cb-1",
      label: "codebuff",
      provider: "codebuff",
      credentials: { authToken: "cb-old" },
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
    }
    const patch = parseBodyToPatch(account, { githubToken: "ghp_wrong" })
    expect(patch.credentialValue).toBeUndefined()
  })
})
