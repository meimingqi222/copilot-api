/**
 * OpenAI-side protocol translation module (reverse of `anthropic/`).
 *
 * Handles Chat Completions payload → Anthropic Messages payload, and
 * Anthropic response/stream → OpenAI chat response/chunks. Used by
 * `chat-via-messages.ts` when a `/v1/chat/completions` request routes to an
 * adapter that only implements `createMessages` (claude-native,
 * anthropic-compatible).
 */

export {
  DEFAULT_VIA_MESSAGES_MAX_TOKENS,
  translateChatPayloadToAnthropic,
} from "./chat-to-messages"
export {
  mapAnthropicStopReasonToOpenAI,
  translateAnthropicResponseToChat,
  translateAnthropicStreamToChatEvents,
} from "./messages-to-chat"
export {
  type AnthropicStreamEventLike,
  type ChatViaMessagesStreamState,
  createChatViaMessagesStreamState,
} from "./types"
