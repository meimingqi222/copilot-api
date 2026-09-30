import { test } from "bun:test"

/**
 * Use only for tests that must open a real local listening socket.
 * Restricted local sandboxes can opt out explicitly. CI always runs them.
 */
export const loopbackTest =
  (
    process.env.CI !== "true"
    && process.env.COPILOT_API_TEST_SKIP_LOOPBACK === "1"
  ) ?
    test.skip
  : test
