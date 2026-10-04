import { computePerformanceDetails } from "~/lib/stats/performance-detail"
import {
  computePerformanceByModel,
  computePerformanceByProviderModel,
} from "~/lib/stats/range-query"
import type { UsageRawRow } from "~/lib/stats/types"

export function computePerformanceBundle(rows: UsageRawRow[]) {
  return {
    performance: computePerformanceByModel(rows),
    details: computePerformanceDetails(rows),
    byProvider: computePerformanceByProviderModel(rows),
  }
}

export type PerformanceBundle = ReturnType<typeof computePerformanceBundle>
