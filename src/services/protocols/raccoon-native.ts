import { HTTPError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"
import {
  performanceFetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import { createOnceAdapter } from "~/services/protocols/once-adapter"
import {
  connectionFetchInit,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"
import { RACCOON_LLM } from "~/services/raccoon/auth"
import { discoverRaccoonModels } from "~/services/raccoon/catalog"

async function* rewriteModels(
  stream: AsyncIterable<CopilotStreamEvent>,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  for await (const event of stream) {
    let raw: unknown
    try {
      raw = JSON.parse(event.data ?? "")
    } catch {
      /* Includes [DONE]. */
    }
    const data = asRecord(raw)
    yield data && Object.hasOwn(data, "model") ?
      { ...event, data: JSON.stringify({ ...data, model }) }
    : event
  }
}

export const raccoonNativeAdapter = createOnceAdapter({
  protocol: "raccoon-native",
  async chat({ connection, credential }, payload, signal) {
    const token = await ensureOAuthConnectionAccessToken(connection, credential)
    if (!token)
      throw new HTTPError(
        "Raccoon access token is missing",
        new Response(null, { status: 401 }),
      )
    const send = (accessToken: string) =>
      performanceFetch(
        `${RACCOON_LLM}/chat/completions`,
        connectionFetchInit(connection, {
          method: "POST",
          signal,
          redirect: "error",
          body: serializeUpstreamBody(payload),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "*/*",
          },
        }),
      )
    let response = await send(token)
    if (response.status === 401) {
      signal?.throwIfAborted()
      const renewed = await ensureOAuthConnectionAccessToken(
        connection,
        credential,
        { forceRefresh: true, failedAccessToken: token },
      )
      if (renewed && renewed !== token) {
        await response.body?.cancel()
        response = await send(renewed)
      }
    }
    if (!response.ok)
      await handleUpstreamFailure(
        response,
        credential,
        "Raccoon request failed",
        "raccoon-native",
      )
    if (payload.stream) {
      const stream = await safeSseStream<CopilotStreamEvent>(
        response,
        detectOpenAIStreamError,
      )
      return rewriteModels(stream, payload.model)
    }
    const result = (await readUpstreamJson(response)) as ChatCompletionResponse
    return { ...result, model: payload.model }
  },
})

raccoonNativeAdapter.discoverModels = ({ connection, signal }) =>
  discoverRaccoonModels(connection, signal)
raccoonNativeAdapter.isModelCreditExempt = (connection, id) =>
  connection.models?.some(
    (m) => m.upstreamId === id && m.metadata?.free === true,
  ) ?? false
