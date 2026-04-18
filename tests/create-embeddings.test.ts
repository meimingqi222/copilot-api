import { afterEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { createEmbeddings } from "~/services/copilot/create-embeddings"

const originalFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
const originalProvider = state.provider

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  state.provider = originalProvider
})

test("strips copilot prefix before forwarding embeddings requests upstream", async () => {
  state.accounts = [
    {
      id: "copilot-1",
      label: "copilot",
      provider: "copilot",
      githubToken: "gh-test-token",
      copilotToken: "copilot-test-token",
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "text-embedding-3-small",
          name: "text-embedding-3-small",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/embeddings"],
          provider: "copilot",
        },
      ],
    },
  ]
  state.activeAccountIndex = 0
  state.provider = "copilot"

  const fetchMock = mock((url: string, options?: { body?: string }) => ({
    ok: true,
    json: () => ({
      object: "list",
      data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    url,
    options,
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const account = state.accounts.at(0)
  if (!account) {
    throw new Error("Expected at least one account in test state")
  }

  const result = await createEmbeddings(
    {
      model: "copilot/text-embedding-3-small",
      input: "hello",
    },
    {
      account,
    },
  )

  expect(result.accountId).toBe("copilot-1")
  const [url, options] = fetchMock.mock.calls[0] as [string, { body?: string }]
  expect(url).toContain("/embeddings")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "text-embedding-3-small",
    input: "hello",
  })
})
