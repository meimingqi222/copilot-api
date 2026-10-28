import { asRecord } from "~/lib/json-shape"
import type { ProviderConnection } from "~/lib/provider-connections/types"

/** Missing or unreadable prices are unknown, never implicitly free. */
function credits(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  const text = String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+credits?$/, "")
    .replace(/^x/, "")
    .replace(/x$/, "")
    .trim()
  if (!text) return undefined
  const rate = Number(text)
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined
}

/** Only explicit, currently valid zero-credit pricing exempts a model. */
export function isCodebuddyModelFree(
  connection: ProviderConnection,
  upstreamModelId: string | undefined,
): boolean {
  if (connection.protocol !== "codebuddy-native" || !upstreamModelId)
    return false
  const metadata = connection.models?.find(
    (model) => model.upstreamId === upstreamModelId,
  )?.metadata
  const base = credits(metadata?.codebuddyCredits)
  const promotions = metadata?.codebuddyPromotions
  if (!Array.isArray(promotions) || promotions.length === 0) return base === 0

  // A cached zero may have been a promotion's price. Recheck validity on each
  // request, and do not treat time-of-day offers as permanently free.
  const now = Date.now()
  return promotions.some((value: unknown) => {
    const promotion = asRecord(value)
    if (promotion?.kind !== "discount" || promotion.enabled === false)
      return false
    const schedule = asRecord(promotion.schedule)
    if (Array.isArray(schedule?.daily) && schedule.daily.length > 0)
      return false
    for (const key of ["validFrom", "validUntil"] as const) {
      const value = schedule?.[key]
      if (value === undefined) continue
      if (typeof value !== "string") return false
      const at = Date.parse(value)
      if (!Number.isFinite(at)) return false
      if (key === "validFrom" ? now < at : now >= at) return false
    }
    const discount = asRecord(promotion.discount)
    if (discount?.discountedCredits !== undefined)
      return credits(discount.discountedCredits) === 0
    const factor = credits(discount?.factor)
    return base !== undefined && factor !== undefined && base * factor === 0
  })
}
