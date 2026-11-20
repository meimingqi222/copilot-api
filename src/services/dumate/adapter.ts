import { HTTPError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import {
  performanceFetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import {
  DUMATE_GATEWAY,
  duMateGatewayToken,
  invalidateDuMateToken,
} from "~/services/dumate/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import {
  connectionFetchInit,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"
import type { ProtocolAdapter } from "~/services/protocols/types"

function duMatePayload(
  payload: ChatCompletionsPayload,
  model: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...payload, model }
  const effort = payload.reasoning_effort
  if (
    model !== "deepseek-v41-flash"
    || (effort !== "none"
      && effort !== "low"
      && effort !== "high"
      && effort !== "max")
  )
    return body
  const enabled = effort !== "none"
  if (!enabled) delete body.reasoning_effort
  else if (effort === "low") body.reasoning_effort = "high"
  body.thinking = {
    ...asRecord(payload.thinking),
    type: enabled ? "enabled" : "disabled",
  }
  body.enable_thinking = enabled
  return body
}

export const duMateNativeAdapter: ProtocolAdapter = {
  protocol: "dumate-native",
  async createChatCompletions({
    connection,
    credential,
    target,
    payload,
    signal,
  }) {
    const cookie = credential.value
    const proxyUrl = getConnectionProxyUrl(connection)
    signal?.throwIfAborted()
    const body = serializeUpstreamBody(
      duMatePayload(payload, target.upstreamModelId),
    )
    const send = (token: string) =>
      performanceFetch(
        `${DUMATE_GATEWAY}/chat/completions`,
        connectionFetchInit(connection, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        }),
      )
    let token = await duMateGatewayToken(cookie, proxyUrl, signal)
    signal?.throwIfAborted()
    let res = await send(token.token)
    if (res.status === 401) {
      invalidateDuMateToken(cookie, proxyUrl, token)
      await res.body?.cancel()
      signal?.throwIfAborted()
      token = await duMateGatewayToken(cookie, proxyUrl, signal)
      signal?.throwIfAborted()
      res = await send(token.token)
    }
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      invalidateDuMateToken(cookie, proxyUrl, token)
      await res.body?.cancel()
      throw new HTTPError(
        "DuMate gateway rejected the current session.",
        new Response(null, { status: 401 }),
      )
    }
    if (!res.ok)
      await handleUpstreamFailure(
        res,
        credential,
        "DuMate chat failed",
        "dumate",
      )
    if (payload.stream)
      return {
        credentialId: credential.id,
        response: await safeSseStream<CopilotStreamEvent>(
          res,
          detectOpenAIStreamError,
        ),
      }
    return {
      credentialId: credential.id,
      response: (await readUpstreamJson(res)) as ChatCompletionResponse,
    }
  },
}
