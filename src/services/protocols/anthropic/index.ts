/**
 * Anthropic protocol types + OpenAI<->Anthropic translation.
 *
 * Lifted from `src/routes/messages/` so the protocol/dispatch layer can reuse
 * the translators for cross-protocol fallback (messages-via-chat), mirroring
 * the chat-via-responses pattern. Route handlers import from here too.
 */

export {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
export {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
  translateStreamEndEvents,
} from "./stream-translation"
export * from "./types"
export * from "./utils"
