/**
 * Serves Anthropic Messages requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. The structured delta twin
 * hint (`collectChatStreamTwin`) is applied by `wire-pairs.ts` for `messages -> chat`.
 */

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import type { AdapterChatResult, AdapterMessagesResult } from "./types"
import { createWireDelegate } from "./wire-delegate"

export const createMessagesViaChat = createWireDelegate<
  AnthropicMessagesPayload,
  ChatCompletionsPayload,
  AdapterChatResult,
  AdapterMessagesResult
>("messages", "chat")
