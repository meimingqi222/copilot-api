/**
 * Serves Chat Completions requests via an Anthropic Messages upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. Default prompt-cache
 * breakpoint injection for `chat -> messages` lives in `wire-pairs.ts`.
 */

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import type { AdapterChatResult, AdapterMessagesResult } from "./types"
import { createWireDelegate } from "./wire-delegate"

export const createChatViaMessages = createWireDelegate<
  ChatCompletionsPayload,
  AnthropicMessagesPayload,
  AdapterMessagesResult,
  AdapterChatResult
>("chat", "messages")
