/**
 * Admin API: the rest registry.
 *
 * A rest is the richer, memory-only side of a candidate sitting out — why it
 * was rested, how many times it failed, and until when. Routing reads it to
 * skip a candidate (see `isCredentialAvailable`), and a held `verify` refusal
 * is answered from it without asking upstream again. This router is the
 * operator's view of that state, plus the one manual action: lift a rest once
 * the account has been dealt with.
 */

import { Hono } from "hono"

import { listRests, unrest } from "~/lib/route-target"

export const restsApiRoutes = new Hono()

/** Every live rest, in the order they lift, plus the key to lift them by. */
restsApiRoutes.get("/", (c) => {
  return c.json({ rests: listRests() })
})

/** Lift one rest by its registry key. */
restsApiRoutes.delete("/:key", (c) => {
  const key = decodeURIComponent(c.req.param("key"))
  return c.json({ ok: unrest(key) })
})
