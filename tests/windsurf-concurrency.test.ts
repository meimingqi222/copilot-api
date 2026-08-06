import { afterEach, describe, expect, test } from "bun:test"

import {
  beginWindsurfAccountRequest,
  getWindsurfConcurrencySnapshot,
  resetWindsurfConcurrencyForTest,
  WindsurfConcurrencyLimitError,
} from "~/services/windsurf/concurrency"

afterEach(() => resetWindsurfConcurrencyForTest())

describe("Windsurf per-account concurrency", () => {
  test("tracks streaming and non-streaming overlap independently", () => {
    const releaseStream = beginWindsurfAccountRequest({
      accountId: "account-1",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    const releaseHelper = beginWindsurfAccountRequest({
      accountId: "account-1",
      accountLabel: "test",
      model: "swe-test",
      streaming: false,
    })

    expect(getWindsurfConcurrencySnapshot("account-1")).toMatchObject({
      active: 2,
      streaming: 1,
      nonStreaming: 1,
    })
    releaseHelper()
    expect(getWindsurfConcurrencySnapshot("account-1")).toMatchObject({
      active: 1,
      streaming: 1,
      nonStreaming: 0,
    })
    releaseStream()
    expect(getWindsurfConcurrencySnapshot("account-1").active).toBe(0)
  })

  test("release is idempotent", () => {
    const release = beginWindsurfAccountRequest({
      accountId: "account-2",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    release()
    release()
    expect(getWindsurfConcurrencySnapshot("account-2").active).toBe(0)
  })

  test("rejects requests above the account limit and preserves active requests", () => {
    const releaseFirst = beginWindsurfAccountRequest({
      accountId: "account-3",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    const releaseSecond = beginWindsurfAccountRequest({
      accountId: "account-3",
      accountLabel: "test",
      model: "swe-test",
      streaming: false,
    })

    expect(() =>
      beginWindsurfAccountRequest({
        accountId: "account-3",
        accountLabel: "test",
        model: "swe-test",
        streaming: true,
      }),
    ).toThrow(WindsurfConcurrencyLimitError)
    expect(getWindsurfConcurrencySnapshot("account-3")).toMatchObject({
      active: 2,
      streaming: 1,
      nonStreaming: 1,
    })

    releaseFirst()
    const releaseThird = beginWindsurfAccountRequest({
      accountId: "account-3",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    expect(getWindsurfConcurrencySnapshot("account-3").active).toBe(2)
    releaseSecond()
    releaseThird()
  })

  test("includes retry headers on limit errors", () => {
    const releaseFirst = beginWindsurfAccountRequest({
      accountId: "account-4",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    const releaseSecond = beginWindsurfAccountRequest({
      accountId: "account-4",
      accountLabel: "test",
      model: "swe-test",
      streaming: true,
    })
    let caught: unknown
    try {
      beginWindsurfAccountRequest({
        accountId: "account-4",
        accountLabel: "test",
        model: "swe-test",
        streaming: true,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WindsurfConcurrencyLimitError)
    const error = caught as WindsurfConcurrencyLimitError
    expect(error.response.status).toBe(429)
    expect(error.response.headers.get("Retry-After")).toBe("1")
    expect(error.response.headers.get("retry-after-ms")).toBe("1000")
    releaseFirst()
    releaseSecond()
  })
})
