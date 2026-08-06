import { afterEach, describe, expect, test } from "bun:test"

import {
  beginWindsurfAccountRequest,
  getWindsurfConcurrencySnapshot,
  resetWindsurfConcurrencyForTest,
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
})
