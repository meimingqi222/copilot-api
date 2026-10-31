/**
 * Admin API: plan allowance readings.
 *
 * A plan reports its allowance as shares of a rolling window rather than as
 * request counts, which makes a reading replayable: the last good one is kept
 * on disk and re-served after a transient upstream failure (see
 * `~/lib/plan-quota`). This router exposes that stored reading, plus a reset
 * for the case where the reading no longer describes the account.
 *
 * Persistence is entirely the store's job: the reset below validates the HTTP
 * input and hands the filter to `clearPlanQuotaReadings`, which serializes the
 * rewrite with ordinary saves and invalidates its own cache.
 */

import { Hono } from "hono"

import { logger } from "~/lib/logger"
import { lastReading } from "~/lib/plan-quota"
import { clearPlanQuotaReadings } from "~/lib/plan-quota/store"

export const planQuotaApiRoutes = new Hono()

/** The last allowance reading for `provider/user`. Null members mean none. */
planQuotaApiRoutes.get("/:provider/:user", async (c) => {
  const provider = c.req.param("provider").trim()
  const user = c.req.param("user").trim()
  if (!provider || !user) {
    return c.json({ error: "provider and user are required." }, 400)
  }

  const reading = await lastReading(provider, user, Date.now())
  if (!reading) {
    return c.json({ windows: null, asOf: null })
  }
  return c.json({ windows: reading.windows, asOf: reading.asOf })
})

/**
 * Clear the stored reading for one provider/user, for a whole provider, or for
 * every account (no filters).
 */
planQuotaApiRoutes.post("/reset", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: unknown
    user?: unknown
  }
  const provider =
    typeof body.provider === "string" && body.provider.trim() ?
      body.provider.trim()
    : undefined
  const user =
    typeof body.user === "string" && body.user.trim() ?
      body.user.trim()
    : undefined

  try {
    await clearPlanQuotaReadings({ provider, user })
  } catch (error) {
    logger.warn(`[plan-quota] Failed to reset readings: ${String(error)}`)
    return c.json({ ok: false, error: "Failed to reset plan readings." }, 500)
  }

  logger.info(
    `Plan readings reset (provider=${provider ?? "*"} user=${user ?? "*"})`,
  )
  return c.json({ ok: true })
})
