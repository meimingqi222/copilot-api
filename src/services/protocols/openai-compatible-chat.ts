/**
 * Shared OpenAI-compatible chat forwarding.
 *
 * The `openai-compatible` and `openai-responses-compatible` adapters forward
 * chat completions identically (same URL, headers, failure handling and SSE
 * branch); only the provider label and the non-stream body parsing differ
 * (e.g. the Cline Pass `data` envelope). Those two hooks are supplied by the
 * caller so the forwarding rule lives in one place.
 */

import {
  performanceFetch as fetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import {
  buildBaseHeaders,
  connectionFetchInit,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterChatResult, AdapterParams } from "./types"

export async function createOpenAICompatibleChatCompletion(
  params: AdapterParams<ChatCompletionsPayload>,
  options: {
    providerLabel: string
    parseNonStream: (raw: Record<string, unknown>) => ChatCompletionResponse
  },
): Promise<AdapterChatResult> {
  const { target, connection, credential, payload, signal } = params
  const upstreamPayload = {
    ...payload,
    model: target.upstreamModelId,
  }

  const response = await fetch(
    joinUrl(connection.baseUrl, "/chat/completions"),
    connectionFetchInit(connection, {
      method: "POST",
      headers: buildBaseHeaders(connection, credential),
      body: serializeUpstreamBody(upstreamPayload),
      signal,
    }),
  )

  if (!response.ok) {
    await handleUpstreamFailure(
      response,
      credential,
      "Failed to create chat completions",
      options.providerLabel,
    )
  }

  if (payload.stream) {
    const stream = await safeSseStream(response, detectOpenAIStreamError)
    return {
      credentialId: credential.id,
      response: stream as unknown as AsyncIterable<CopilotStreamEvent>,
    }
  }

  const raw = (await readUpstreamJson(response)) as Record<string, unknown>
  return {
    credentialId: credential.id,
    response: options.parseNonStream(raw),
  }
}
