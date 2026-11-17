import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import {
  decodeMessagesRequest,
  encodeChatRequest,
  decodeChatStream,
  encodeMessagesStream,
  encodeMessagesResponse,
  decodeChatResponse,
} from "~/services/ir/codecs/messages-chat"
import { aggregateTranslatedStream } from "~/services/protocols/sse-aggregate"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"

/** The request stays native; only the existing response codecs translate output. */
export async function createWindsurfMessagesOnce(
  target: { connection: ProviderConnection; credential: ApiCredential },
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<unknown> | Record<string, unknown>> {
  if (
    payload.messages.some(
      (message) =>
        Array.isArray(message.content)
        && message.content.some(
          (block) =>
            (block.type === "image" && block.source.type === "url")
            || (block.type === "tool_result"
              && Array.isArray(block.content)
              && block.content.some(
                (part) => part.type === "image" && part.source.type === "url",
              )),
        ),
    )
  ) {
    // Native protobuf carries image bytes, not URLs; never silently lose input
    // or introduce an unrestricted server-side image downloader here.
    throw new LocalPayloadUnsupportedError(
      "Devin does not support URL images; send base64 image blocks instead.",
    )
  }
  if (payload.tools?.some((tool) => !("input_schema" in tool))) {
    throw new LocalPayloadUnsupportedError(
      "Devin does not execute Anthropic server tools; use the Chat search orchestration path instead.",
    )
  }
  // This view selects the model/session and reuses structured-output handling.
  // buildRequest consumes messagesPayload, not this lossy Chat history.
  const chat = encodeChatRequest(decodeMessagesRequest(payload), {
    preserveHistoricalReasoning: true,
    preserveReasoningOrder: true,
    stream: true,
  })
  const response = await createWindsurfChatCompletionsOnce(
    { ...target, messagesPayload: payload },
    chat,
    signal,
    { ...ctx, collectChatStreamTwin: true },
  )
  if ("choices" in response) {
    // Structured output is deliberately validated before streaming by the
    // shared adapter. Turn its already validated result into ordered IR too.
    return { ...encodeMessagesResponse(decodeChatResponse(response)) }
  }
  const events = decodeChatStream(response)
  if (!payload.stream)
    return {
      ...encodeMessagesResponse(await aggregateTranslatedStream(events)),
    }
  return (async function* () {
    for await (const event of encodeMessagesStream(events, 0)) {
      yield { event: event.type, data: JSON.stringify(event) }
    }
  })()
}
