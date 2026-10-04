import { parentPort } from "node:worker_threads"
import { computePerformanceBundle } from "~/lib/stats/performance-bundle"
import type { UsageRawRow } from "~/lib/stats/types"

parentPort?.on(
  "message",
  ({ id, rows }: { id: number; rows: UsageRawRow[] }) => {
    try {
      parentPort?.postMessage({ id, result: computePerformanceBundle(rows) })
    } catch (error) {
      parentPort?.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
)
