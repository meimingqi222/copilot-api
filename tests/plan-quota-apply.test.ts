/**
 * Plan allowance apply tests.
 *
 * A good reading replaces the last one; a transient failure replays the last
 * one as stale instead of losing it; a terminal failure leaves the store alone
 * and stops claiming the reading. Routing evidence prefers the replayed reading
 * when the credential's own snapshot is missing or stale, and keeps using the
 * snapshot when it is fresh.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { PlanAllowance } from "~/lib/plan-quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  __resetPlanAllowanceMirrorForTest,
  noteSnapshotReading,
  planAccountFor,
  planAllowanceFor,
  planWindowsFromSnapshot,
  recordAllowanceReading,
} from "~/lib/plan-quota/apply"
import {
  keepReading,
  lastReading,
  resetPlanQuotaStore,
  setPlanQuotaFilePath,
} from "~/lib/plan-quota"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  ensureConnectionMetadata,
  setConnectionCredentialExtra,
} from "~/lib/provider-connections"
import { routeEvidenceFor } from "~/lib/route-target"

const MINUTE = 60_000
const HOUR = 3_600_000
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * 24 * HOUR

const NOW = 1_800_000_000_000

/** An account-managed Claude connection, with the plan email set. */
async function claudeConnection(
  id: string,
  email: string,
): Promise<ProviderConnection> {
  const conn = await createConnection({
    id,
    name: id,
    protocol: "claude-native",
    baseUrl: "https://api.anthropic.com",
    models: [
      {
        publicId: "claude-sonnet-4-5",
        upstreamId: "claude-sonnet-4-5",
        endpoints: ["messages"],
        enabled: true,
      },
    ],
    credentials: [{ id: `${id}-cred`, value: "sk-ant", authMode: "bearer" }],
  })
  ensureConnectionMetadata(conn)
  setConnectionCredentialExtra(conn, "email", email)
  return conn
}

describe("recordAllowanceReading", () => {
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `plan-quota-apply-${randomUUID()}-`),
    )
    filePath = path.join(tempDir, "plan-quota.json")
    setPlanQuotaFilePath(filePath)
    __resetPlanAllowanceMirrorForTest()
  })

  afterEach(async () => {
    resetPlanQuotaStore()
    __resetPlanAllowanceMirrorForTest()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test("a good reading is stored and replaces the last one", async () => {
    const first: PlanAllowance = [
      { used: 0.2, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
    ]
    const second: PlanAllowance = [
      { used: 0.6, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
    ]

    const recorded = await recordAllowanceReading(
      { provider: "claude", user: "a@example.com", windows: first },
      NOW,
    )

    expect(recorded.stale).toBe(false)
    expect(recorded.asOf).toBe(NOW)
    expect(recorded.windows).toEqual(first)

    // The same account under different capitalization is the same reading.
    await recordAllowanceReading(
      { provider: "claude", user: "A@Example.com", windows: second },
      NOW + MINUTE,
    )

    const stored = await lastReading("claude", "a@example.com", NOW + MINUTE)
    expect(stored?.windows).toEqual(second)
    expect(stored?.asOf).toBe(NOW + MINUTE)
    expect(
      planAllowanceFor("claude", "a@example.com", NOW + MINUTE)?.windows,
    ).toEqual(second)
  })

  test("a passing error replays the last reading as stale", async () => {
    const windows: PlanAllowance = [
      { used: 0.4, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
    ]
    await recordAllowanceReading(
      { provider: "claude", user: "a@example.com", windows },
      NOW,
    )

    const replayed = await recordAllowanceReading(
      {
        provider: "claude",
        user: "a@example.com",
        error: "429 Too Many Requests",
      },
      NOW + MINUTE,
    )

    expect(replayed.stale).toBe(true)
    // The reading keeps its original age, so the caller can say how old it is.
    expect(replayed.asOf).toBe(NOW)
    expect(replayed.windows).toEqual(windows)

    // The synchronous read side serves the same replay — no disk on the path.
    const served = planAllowanceFor("claude", "a@example.com", NOW + MINUTE)
    expect(served?.stale).toBe(true)
    expect(served?.windows).toEqual(windows)
  })

  test("a replay advances windows that renewed since the reading", async () => {
    await recordAllowanceReading(
      {
        provider: "claude",
        user: "a@example.com",
        windows: [{ used: 1, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR }],
      },
      NOW,
    )

    const replayed = await recordAllowanceReading(
      { provider: "claude", user: "a@example.com", error: "fetch failed" },
      NOW + 2 * HOUR,
    )

    expect(replayed.stale).toBe(true)
    expect(replayed.windows[0]?.used).toBe(0)
  })

  test("a terminal error leaves the stored reading alone", async () => {
    const windows: PlanAllowance = [{ used: 0.4, spanMs: FIVE_HOURS }]
    await recordAllowanceReading(
      { provider: "claude", user: "a@example.com", windows },
      NOW,
    )

    const merged = await recordAllowanceReading(
      {
        provider: "claude",
        user: "a@example.com",
        error: "invalid_grant: sign-in expired",
      },
      NOW + MINUTE,
    )

    expect(merged.stale).toBe(false)
    expect(merged.windows).toEqual([])
    // The durable reading is untouched, but the reading this process serves is
    // gone: it no longer describes the account.
    expect(await lastReading("claude", "a@example.com", NOW + MINUTE)).toEqual({
      windows,
      asOf: NOW,
    })
    expect(
      planAllowanceFor("claude", "a@example.com", NOW + MINUTE),
    ).toBeUndefined()
  })

  test("a passing error with nothing stored is not a reading", async () => {
    const merged = await recordAllowanceReading(
      { provider: "claude", user: "nobody@example.com", error: "fetch failed" },
      NOW,
    )

    expect(merged.stale).toBe(true)
    expect(merged.windows).toEqual([])
    expect(
      planAllowanceFor("claude", "nobody@example.com", NOW),
    ).toBeUndefined()
  })
})

describe("planWindowsFromSnapshot", () => {
  test("reads the canonical window list, scoping model windows", () => {
    const windows = planWindowsFromSnapshot({
      fetchedAt: NOW,
      unlimited: false,
      details: {
        _quotaWindows: [
          {
            id: "five_hour",
            labelKey: "quota.oauth.claude.fiveHour",
            windowStartMs: NOW,
            windowEndMs: NOW + FIVE_HOURS,
            usedPercent: 25,
          },
          {
            id: "seven_day_opus",
            labelKey: "quota.oauth.claude.sevenDayOpus",
            windowStartMs: NOW,
            windowEndMs: NOW + SEVEN_DAYS,
            usedPercent: 90,
          },
          // No readable share: not measured is not zero.
          {
            id: "seven_day",
            labelKey: "quota.oauth.claude.sevenDay",
            windowStartMs: NOW,
            windowEndMs: NOW + SEVEN_DAYS,
            usedPercent: null,
          },
        ],
      },
    })

    expect(windows).toEqual([
      { used: 0.25, spanMs: FIVE_HOURS, resetsAtMs: NOW + FIVE_HOURS },
      {
        used: 0.9,
        spanMs: SEVEN_DAYS,
        resetsAtMs: NOW + SEVEN_DAYS,
        model: "opus",
      },
    ])
  })

  test("a snapshot with no window list carries no reading", () => {
    expect(
      planWindowsFromSnapshot({
        fetchedAt: NOW,
        unlimited: false,
        premiumInteractionsRemaining: 50,
      }),
    ).toEqual([])
  })
})

describe("quota write path", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetPlanAllowanceMirrorForTest()
  })

  afterEach(() => {
    __resetProviderConnectionsForTest()
    __resetPlanAllowanceMirrorForTest()
  })

  test("a snapshot noted on the write path becomes the reading", async () => {
    const conn = await claudeConnection("claude-write", "write@example.com")
    const account = planAccountFor(conn)
    expect(account).toEqual({ provider: "claude", user: "write@example.com" })

    noteSnapshotReading(conn, {
      fetchedAt: Date.now(),
      unlimited: false,
      details: {
        _quotaWindows: [
          {
            id: "five_hour",
            labelKey: "quota.oauth.claude.fiveHour",
            windowStartMs: Date.now(),
            windowEndMs: Date.now() + FIVE_HOURS,
            usedPercent: 40,
          },
        ],
      },
    })

    // The write is fire-and-forget by design, so the mirror fills a tick later.
    await waitFor(
      () => planAllowanceFor(account!.provider, account!.user) !== undefined,
    )
    expect(
      planAllowanceFor(account!.provider, account!.user, Date.now())?.windows[0]
        ?.used,
    ).toBe(0.4)
  })
})

describe("routing evidence", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetPlanAllowanceMirrorForTest()
  })

  afterEach(() => {
    __resetProviderConnectionsForTest()
    __resetPlanAllowanceMirrorForTest()
  })

  test("a replayed reading stands in for a credential with no snapshot", async () => {
    const conn = await claudeConnection("claude-nosnap", "nosnap@example.com")
    const account = planAccountFor(conn)
    expect(account).toEqual({ provider: "claude", user: "nosnap@example.com" })

    const now = Date.now()
    const windows: PlanAllowance = [
      { used: 0.8, spanMs: FIVE_HOURS, resetsAtMs: now + HOUR },
      { used: 0.1, spanMs: SEVEN_DAYS, resetsAtMs: now + SEVEN_DAYS },
    ]
    // A reading taken ten minutes ago, then the refresh that failed.
    await keepReading(
      account!.provider,
      account!.user,
      windows,
      now - 10 * MINUTE,
    )
    await recordAllowanceReading(
      { ...account!, error: "429 Too Many Requests" },
      now,
    )

    const evidence = routeEvidenceFor(
      conn.id,
      conn.credentials[0]!.id,
      "claude-sonnet-4-5",
    )

    expect(evidence.quota?.usedFraction).toBe(0.8)
    expect(evidence.quota?.renewsAtMs).toEqual([now + SEVEN_DAYS, now + HOUR])
    expect(evidence.quota?.staleMs).toBeGreaterThan(9 * MINUTE)
  })

  test("a stale snapshot gives way to the reading, a fresh one wins", async () => {
    const conn = await claudeConnection("claude-stale", "stale@example.com")
    const account = planAccountFor(conn)
    await recordAllowanceReading({
      ...account!,
      windows: [{ used: 0.1, spanMs: FIVE_HOURS }],
    })

    const credential = conn.credentials[0]!
    credential.quota = {
      fetchedAt: Date.now() - 2 * HOUR,
      chatRemaining: 1,
      chatTotal: 100,
      unlimited: false,
    }
    expect(
      routeEvidenceFor(conn.id, credential.id, "claude-sonnet-4-5").quota
        ?.usedFraction,
    ).toBe(0.1)

    // A snapshot that is still fresh stays the answer, exactly as before.
    credential.quota = {
      fetchedAt: Date.now(),
      chatRemaining: 1,
      chatTotal: 100,
      unlimited: false,
    }
    expect(
      routeEvidenceFor(conn.id, credential.id, "claude-sonnet-4-5").quota
        ?.usedFraction,
    ).toBe(0.99)
  })

  test("a stale snapshot with no reading keeps today's evidence", async () => {
    const conn = await claudeConnection("claude-noread", "noread@example.com")
    const credential = conn.credentials[0]!
    credential.quota = {
      fetchedAt: Date.now() - 2 * HOUR,
      chatRemaining: 1,
      chatTotal: 100,
      unlimited: false,
    }

    const evidence = routeEvidenceFor(
      conn.id,
      credential.id,
      "claude-sonnet-4-5",
    )

    expect(evidence.quota?.usedFraction).toBe(0.99)
    expect(evidence.quota?.staleMs).toBeGreaterThan(HOUR)
  })
})

/** Poll a condition a bounded number of times, yielding between attempts. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return
    await Bun.sleep(1)
  }
  throw new Error("condition was never met")
}
