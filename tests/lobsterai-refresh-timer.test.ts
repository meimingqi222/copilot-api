import { afterEach, expect, mock, spyOn, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  cancelLobsteraiRefreshTimer,
  scheduleLobsteraiRefresh,
} from "~/services/lobsterai/token-refresh"

const originalSetTimeout = globalThis.setTimeout
const originalFetch = globalThis.fetch
const id = "lobsterai-long-timer-test"

afterEach(() => {
  cancelLobsteraiRefreshTimer(id)
  mock.restore()
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

test("LobsterAI long-lived credentials never overflow timers or refresh early", async () => {
  const now = Date.now()
  const conn: ProviderConnection = {
    id,
    name: "timer test",
    protocol: "lobsterai-native",
    baseUrl: "https://example.invalid",
    enabled: true,
    priority: 0,
    models: [],
    createdAt: now,
    updatedAt: now,
    credentials: [
      {
        id: "timer-credential",
        authMode: "bearer",
        value: "access",
        enabled: true,
        status: "ready",
        createdAt: now,
        context: { refreshToken: "refresh", expiresAt: now + 30 * 86400_000 },
      },
    ],
  }
  upsertProviderConnection(conn)
  const delays: Array<number | undefined> = []
  let fire: (() => unknown) | undefined
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => unknown,
    delay?: number,
  ) => {
    delays.push(delay)
    fire = () => handler()
    return originalSetTimeout(() => {}, 2_147_483_647)
  }) as unknown as typeof setTimeout)
  const fetchMock = mock(() =>
    Promise.reject(new Error("must not refresh early")),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  scheduleLobsteraiRefresh(conn)
  expect(delays).toEqual([2_147_483_647])
  await fire?.()
  expect(delays).toEqual([2_147_483_647, 2_147_483_647])
  expect(fetchMock).not.toHaveBeenCalled()
  timerSpy.mockRestore()
})
