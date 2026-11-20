import { delay } from "~/lib/delay"
import { HTTPError } from "~/lib/error"
import { asNumber, asRecord } from "~/lib/json-shape"
import type { ProviderConnection } from "~/lib/provider-connections"
import { codeArtsFetch, type CodeArtsKeys } from "~/services/codearts/client"
import { codeArtsStations } from "~/services/codearts/stations"

interface QueueContext {
  connection: ProviderConnection
  keys: CodeArtsKeys
  session: string
  deadline: number
  hasFallback?: boolean
  signal: AbortSignal
}

export async function waitCodeArtsQueue(
  response: Response,
  ctx: QueueContext,
): Promise<boolean> {
  const trace = response.headers.get("trace-id")
  if (
    response.status !== 429
    || response.headers.get("queue-status")?.toLowerCase() !== "queued"
    || !trace
    || !/^[a-z\d_-]{1,128}$/i.test(trace)
  )
    return false
  await response.body?.cancel()
  const url = new URL(
    `/api/v1/concurrency/trace-queues/${trace}`,
    codeArtsStations[ctx.keys.station].snap,
  )
  const headers = { "x-ot-session-id": ctx.session }
  let promoted = false
  let failures = 0
  let wait = Math.max(0, asNumber(response.headers.get("retry-after")) ?? 5)
  try {
    if (ctx.hasFallback) {
      throw new HTTPError(
        "CodeArts queued the request; trying another route",
        new Response(null, {
          status: 503,
          headers: { "retry-after": String(wait) },
        }),
      )
    }
    while (Date.now() + wait * 1000 < ctx.deadline) {
      ctx.signal.throwIfAborted()
      await delay(wait * 1000, ctx.signal)
      try {
        const remaining = Math.max(1, ctx.deadline - Date.now())
        const signal = AbortSignal.any([
          ctx.signal,
          AbortSignal.timeout(Math.min(30_000, remaining)),
        ])
        const poll = await codeArtsFetch(ctx.connection, ctx.keys, {
          url,
          signal,
          headers,
        })
        const answer = asRecord(await poll.json())
        if (answer?.status === "promoted") {
          promoted = true
          return true
        }
        if (answer?.status === "not_found" || answer?.status === "error") break
        if (!poll.ok) throw new Error("CodeArts queue poll failed")
        failures = 0
        wait = Math.max(1, asNumber(answer?.retry_after) ?? wait)
      } catch {
        ctx.signal.throwIfAborted()
        if (++failures >= 3) break
        wait = Math.max(1, wait)
      }
    }
    throw new HTTPError(
      "CodeArts queue did not promote the request",
      new Response(null, {
        status: 429,
        headers: { "retry-after": String(wait) },
      }),
    )
  } finally {
    if (!promoted) {
      // Cancel only this inference's queued trace, even if the caller left.
      void codeArtsFetch(ctx.connection, ctx.keys, {
        method: "DELETE",
        url,
        headers,
        signal: AbortSignal.timeout(5_000),
      })
        .then((res) => res.body?.cancel())
        .catch(() => undefined)
    }
  }
}
