import { afterEach, beforeEach, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

import { clearJobsForTest, everyMs, listJobs, runJob } from "~/lib/jobs"
import {
  configureLoggerForTest,
  createLogger,
  resetLoggerForTest,
} from "~/lib/logger"
import { recentSystemLogs } from "~/lib/system-log-bus"

const logger = createLogger("quota")

beforeEach(() => {
  configureLoggerForTest({
    logFilePath: path.join(os.tmpdir(), `jobs-test-${process.pid}.jsonl`),
    resetReporter: true,
  })
  clearJobsForTest()
})

afterEach(() => resetLoggerForTest())

const job = (name: string) => listJobs().find((item) => item.name === name)!

test("connection jobs retain their connection in correlated log entries", async () => {
  await runJob("connection-refresh", () => logger.warn("refresh failed"), {
    connectionId: "conn-refresh",
  })
  expect(
    recentSystemLogs().findLast((entry) => entry.job === "connection-refresh"),
  ).toMatchObject({ conn: "conn-refresh" })
})

test("a clean run is ok; a thrown error fails it and is rethrown", async () => {
  await runJob("probe", () => 1, { label: "Probe", schedule: everyMs(300_000) })
  expect(job("probe")).toMatchObject({
    label: "Probe",
    schedule: "every 5 min",
    runs: 1,
    running: false,
    lastOutcome: "ok",
    consecutiveFailures: 0,
  })
  await expect(
    runJob("probe", () => {
      throw new Error("upstream down")
    }),
  ).rejects.toThrow("upstream down")
  expect(job("probe")).toMatchObject({
    lastOutcome: "error",
    consecutiveFailures: 1,
    lastProblem: { message: "upstream down" },
  })
  await runJob("probe", () => undefined)
  // Recovered: the count resets, the last problem stays for reference.
  expect(job("probe")).toMatchObject({
    lastOutcome: "ok",
    consecutiveFailures: 0,
    lastProblem: { message: "upstream down" },
  })
})

test("a warning a job logs and swallows marks its run, and the line carries the run", async () => {
  await runJob("quota-refresh", async () => {
    await Promise.resolve()
    logger.warn("Failed to refresh quota for connection:", new Error("429"))
  })
  const status = job("quota-refresh")
  expect(status.lastOutcome).toBe("warn")
  expect(status.lastProblem?.message).toContain("Failed to refresh quota")
  const line = recentSystemLogs().findLast(
    (entry) => entry.job === "quota-refresh",
  )
  expect(line).toMatchObject({ sub: "quota", run: status.lastProblem?.run })
  expect(line?.err?.message).toBe("429")
})
