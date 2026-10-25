/**
 * Background job registry: what each scheduler last did.
 *
 * The system log says what happened; this says what is broken now. Each
 * background loop runs its body through `runJob(name, fn)`, which records the
 * run and gives every log line written inside it the job and run ids, so the
 * admin page can link a failed run to its lines.
 *
 * Many jobs catch their own errors and only log them (a quota refresh that
 * fails for one connection goes on with the next). So a warn or error line
 * written during a run marks it as partly failed, without the job's body
 * having to report anything.
 */

import { randomBytes } from "node:crypto"

import { runWithLogContext } from "~/lib/log-context"
import { subscribeSystemLogs } from "~/lib/system-log-bus"

type JobOutcome = "ok" | "warn" | "error"

interface JobStatus {
  name: string
  /** What it is, for the status page ("Copilot token refresh"). */
  label?: string
  /** Connection the job serves, when it serves one. */
  connectionId?: string
  /** How often it runs, as people read it ("every 5 min"). */
  schedule?: string
  running: boolean
  runs: number
  lastStartAt?: number
  lastEndAt?: number
  lastDurationMs?: number
  lastOutcome?: JobOutcome
  /** The last run's first failure; a later clean run keeps it for reference. */
  lastProblem?: { message: string; at: number; run: string }
  consecutiveFailures: number
  nextRunAt?: number
}

interface ActiveRun {
  outcome: JobOutcome
  problem?: string
}

const MAX_JOBS = 500
const jobs = new Map<string, JobStatus>()
const active = new Map<string, ActiveRun>()

function jobFor(name: string): JobStatus {
  let job = jobs.get(name)
  if (!job) {
    if (jobs.size >= MAX_JOBS) {
      // Per-connection jobs of deleted connections age out first.
      const oldest = [...jobs.values()]
        .filter((item) => !item.running)
        .sort((a, b) => (a.lastStartAt ?? 0) - (b.lastStartAt ?? 0))[0]
      if (oldest) jobs.delete(oldest.name)
    }
    job = { name, running: false, runs: 0, consecutiveFailures: 0 }
    jobs.set(name, job)
  }
  return job
}

/** Describes a job before or between its runs. */
export function describeJob(
  name: string,
  info: Pick<JobStatus, "label" | "schedule" | "connectionId" | "nextRunAt">,
): void {
  Object.assign(jobFor(name), info)
}

/**
 * Runs one pass of a background job. Errors are rethrown unchanged, so a
 * caller's own retry or logging keeps working.
 */
export async function runJob<T>(
  name: string,
  fn: () => Promise<T> | T,
  info: Pick<JobStatus, "label" | "schedule" | "connectionId"> = {},
): Promise<T> {
  const job = jobFor(name)
  Object.assign(job, info)
  const run = randomBytes(6).toString("hex")
  const started = Date.now()
  job.running = true
  job.runs += 1
  job.lastStartAt = started
  job.nextRunAt = undefined
  const state: ActiveRun = { outcome: "ok" }
  active.set(run, state)
  try {
    const result = await runWithLogContext(
      {
        job: name,
        run,
        ...(job.connectionId ? { conn: job.connectionId } : {}),
      },
      fn,
    )
    return result
  } catch (error) {
    state.outcome = "error"
    state.problem ??= error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    active.delete(run)
    job.running = false
    job.lastEndAt = Date.now()
    job.lastDurationMs = job.lastEndAt - started
    job.lastOutcome = state.outcome
    if (state.outcome === "ok") job.consecutiveFailures = 0
    else {
      job.consecutiveFailures += 1
      job.lastProblem = {
        message: state.problem ?? "failed",
        at: job.lastEndAt,
        run,
      }
    }
  }
}

/** Marks the current run when a job's body logs a warning or an error. */
subscribeSystemLogs((entry) => {
  if (
    !entry.run
    || (entry.level !== "warn"
      && entry.level !== "error"
      && entry.level !== "fatal")
  )
    return
  const state = active.get(entry.run)
  if (!state) return
  if (state.outcome === "ok") state.outcome = "warn"
  if (entry.level !== "warn") state.outcome = "error"
  state.problem ??= entry.msg
})

/** "every 30 s", "every 5 min", "every 2 h" for a job's schedule. */
export function everyMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `every ${ms / 60_000} min`
  return `every ${Math.round(ms / 1000)} s`
}

export function listJobs(): Array<JobStatus> {
  return [...jobs.values()]
    .map((job) => ({ ...job }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function clearJobsForTest(): void {
  jobs.clear()
  active.clear()
}
