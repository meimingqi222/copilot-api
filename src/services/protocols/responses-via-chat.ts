/**
 * Serves Responses requests via a Chat Completions upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. Memory-diagnostics trace
 * phases for `responses -> chat` are wired in `wire-pairs.ts`.
 */

import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"

import type { AdapterChatResult, AdapterResponsesResult } from "./types"
import { createWireDelegate } from "./wire-delegate"

export const createResponsesViaChat = createWireDelegate<
  ResponsesPayload,
  ChatCompletionsPayload,
  AdapterChatResult,
  AdapterResponsesResult
>("responses", "chat")
