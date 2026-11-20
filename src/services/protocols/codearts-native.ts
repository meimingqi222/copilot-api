import { createHash, randomBytes } from "node:crypto"

import { delay } from "~/lib/delay"
import { HTTPError } from "~/lib/error"
import {
  getMutableProviderConnection,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { prepareCodeArtsChat } from "~/services/codearts/chat-body"
import {
  codeArtsError,
  openCodeArtsStream,
} from "~/services/codearts/chat-stream"
import {
  codeArtsFetch,
  codeArtsKeys,
  type CodeArtsKeys,
} from "~/services/codearts/client"
import { discoverCodeArtsModels } from "~/services/codearts/models"
import { waitCodeArtsQueue } from "~/services/codearts/queue"
import { codeArtsStations } from "~/services/codearts/stations"
import { CredentialConcurrencyLimitError } from "~/services/dispatch/concurrency"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { aggregateSseToResponse } from "~/services/protocols/sse-aggregate"
import type { AdapterParams, ProtocolAdapter } from "~/services/protocols/types"

const MAX_SIGNED_BODY = 12 * 1024 * 1024
const active = new Map<string, number>()

function takePermit(account: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const count = active.get(account) ?? 0
  if (count >= 3)
    throw new CredentialConcurrencyLimitError(
      account,
      "CodeArts permits at most 3 active chats per account",
    )
  active.set(account, count + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    signal.removeEventListener("abort", release)
    const remaining = (active.get(account) ?? 1) - 1
    if (remaining > 0) active.set(account, remaining)
    else active.delete(account)
  }
  signal.addEventListener("abort", release, { once: true })
  return release
}

const hex = (size: number) => randomBytes(size).toString("hex")

function chatHeaders(session: string, chat: string) {
  return {
    Accept: "text/event-stream",
    "Chat-Id": chat,
    "Session-Id": session,
    "x-ot-session-id": session,
    "user-session-id": session,
    "x-ot-parent-session-id": "",
    "x-ot-trace-id": hex(16),
    "x-ot-span-id": hex(8),
    "x-snap-traceid": hex(16),
    Lang: "en",
  }
}

async function renewCodeArts(
  connection: ProviderConnection,
  refused: CodeArtsKeys,
): Promise<CodeArtsKeys | undefined> {
  const live = getMutableProviderConnection(connection.id)
  if (!live) return undefined
  const latest = codeArtsKeys(live.credentials[0])
  const changed = (key: CodeArtsKeys) =>
    key.accessKey !== refused.accessKey
    || key.securityToken !== refused.securityToken
  if (changed(latest)) return latest
  const { refreshOAuthConnectionToken } = await import(
    "~/services/oauth/refresh-scheduler"
  )
  try {
    await refreshOAuthConnectionToken(
      live,
      "CodeArts temporary credential refused",
    )
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      throw new HTTPError(
        "CodeArts sign-in expired; sign in again",
        new Response(null, { status: 401 }),
      )
    }
    throw new HTTPError(
      "CodeArts STS is temporarily unavailable",
      new Response(null, { status: 503 }),
    )
  }
  const refreshed = getMutableProviderConnection(live.id)
  if (!refreshed) return undefined
  const keys = codeArtsKeys(refreshed.credentials[0])
  return changed(keys) ? keys : undefined
}

async function openCodeArtsChat(
  params: AdapterParams<ChatCompletionsPayload>,
  parts: {
    keys: CodeArtsKeys
    session: string
    chat: string
    signal: AbortSignal
  },
) {
  const { connection, target, payload, ctx } = params
  const { session, chat, signal } = parts
  let keys = parts.keys
  const prepared = prepareCodeArtsChat(
    payload,
    target.upstreamModelId,
    keys.station,
  )
  let canRemoveThinking = prepared.injected
  let renewed = false
  let sessionRetries = 0
  const start = Date.now()
  for (;;) {
    signal.throwIfAborted()
    const wire = JSON.stringify(prepared.wire)
    if (Buffer.byteLength(wire) > MAX_SIGNED_BODY)
      throw new HTTPError(
        "CodeArts accepts request bodies up to 12 MiB",
        new Response(null, { status: 413 }),
      )
    const controller = new AbortController()
    const attempt = AbortSignal.any([signal, controller.signal])
    const snap = codeArtsStations[keys.station].snap
    const timeout = setTimeout(
      () =>
        controller.abort(
          new HTTPError(
            "CodeArts timed out before its first answer",
            new Response(null, { status: 504 }),
          ),
        ),
      120_000,
    )
    try {
      const res = await codeArtsFetch(connection, keys, {
        url: new URL("/api/v2/chat/completions", snap),
        method: "POST",
        body: wire,
        headers: chatHeaders(session, chat),
        signal: attempt,
      })
      if (res.ok) {
        const upstream = await openCodeArtsStream(res, prepared.names)
        return {
          upstream,
          model: prepared.model,
          close: () => controller.abort(),
        }
      }
      if (
        res.status === 429
        && res.headers.get("queue-status")?.toLowerCase() === "queued"
      )
        clearTimeout(timeout)
      if (
        await waitCodeArtsQueue(res, {
          connection,
          keys,
          session,
          deadline: start + 300_000,
          hasFallback: ctx?.hasFallback?.(),
          signal,
        })
      )
        continue
      throw codeArtsError(await res.text(), res)
    } catch (error) {
      if (attempt.aborted) throw attempt.reason
      controller.abort()
      if (!(error instanceof HTTPError)) throw error
      const { status } = error.response
      if (status === 401 && !renewed) {
        renewed = true
        const next = await renewCodeArts(connection, keys)
        if (next?.station === keys.station) {
          keys = next
          continue
        }
      }
      if (
        status === 400
        && canRemoveThinking
        && /thinking/i.test(error.message)
      ) {
        canRemoveThinking = false
        delete prepared.wire.thinking
        continue
      }
      const wait = [2_000, 4_000, 6_000, 8_000, 10_000][
        Math.min(4, sessionRetries)
      ]
      if (
        /TM\.00001041/.test(error.responseBody)
        && !ctx?.hasFallback?.()
        && Date.now() - start + wait <= 150_000
      ) {
        sessionRetries++
        await delay(wait, signal)
        continue
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const codeArtsNativeAdapter: ProtocolAdapter = {
  protocol: "codearts-native",
  discoverModels: ({ connection, signal, credential }) =>
    discoverCodeArtsModels(connection, signal, credential),
  async createChatCompletions(params) {
    const { connection, credential, payload, ctx } = params
    const keys = codeArtsKeys(credential)
    const limit = AbortSignal.timeout(15 * 60_000)
    const signal =
      params.signal ? AbortSignal.any([params.signal, limit]) : limit
    const identity = credential.context?.oauthAccountId ?? connection.id
    const digest = createHash("sha256")
      .update(`codearts-session:${keys.station}:${String(identity)}`)
      .digest("hex")
    const release = takePermit(digest, signal)
    try {
      const { upstream, model, close } = await openCodeArtsChat(params, {
        keys,
        session: digest.slice(0, 32),
        chat: digest.slice(32),
        signal,
      })
      const stream = (async function* () {
        try {
          yield* upstream
        } finally {
          close()
          release()
        }
      })()
      if (!payload.stream && !ctx?.preferStreamingResponse) {
        return {
          credentialId: credential.id,
          response: await aggregateSseToResponse(stream, model),
        }
      }
      return { credentialId: credential.id, response: stream }
    } catch (error) {
      release()
      throw error
    }
  },
}
