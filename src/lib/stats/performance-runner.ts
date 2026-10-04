import { Worker } from "node:worker_threads"
import {
  computePerformanceBundle,
  type PerformanceBundle,
} from "~/lib/stats/performance-bundle"
import type { UsageRawRow } from "~/lib/stats/types"

const WORKER_THRESHOLD = 5_000
const MAX_PENDING = 4
let worker: Worker | undefined
let nextId = 0
const pending = new Map<
  number,
  {
    resolve: (result: PerformanceBundle) => void
    reject: (error: Error) => void
  }
>()

function getWorker(): Worker {
  if (worker) return worker
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const current = new Worker(
    new URL(`./performance-worker.${extension}`, import.meta.url),
  )
  worker = current
  current.on(
    "message",
    (message: { id: number; result: PerformanceBundle; error?: string }) => {
      const job = pending.get(message.id)
      if (!job) return
      pending.delete(message.id)
      if (message.error) job.reject(new Error(message.error))
      else job.resolve(message.result)
      if (!pending.size) current.unref()
    },
  )
  const fail = (error: Error) => {
    if (worker !== current) return
    worker = undefined
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    void current.terminate()
  }
  current.on("error", fail)
  current.on("exit", (code) =>
    fail(new Error(`Performance worker exited (${code})`)),
  )
  current.unref()
  return current
}

/** Small ranges stay local; large percentile sorts must not block chat traffic. */
export function runPerformanceBundle(
  rows: UsageRawRow[],
): Promise<PerformanceBundle> {
  if (rows.length < WORKER_THRESHOLD)
    return Promise.resolve(computePerformanceBundle(rows))
  if (pending.size >= MAX_PENDING)
    return Promise.reject(new Error("Performance aggregation queue is full"))
  const current = getWorker()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    current.ref()
    try {
      current.postMessage({ id, rows })
    } catch (error) {
      pending.delete(id)
      if (!pending.size) current.unref()
      reject(error)
    }
  })
}
