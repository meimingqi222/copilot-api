/**
 * Serves Chat Completions requests via a Responses upstream.
 *
 * Thin delegate over {@link createTranslatedCall}: the generic IR pipeline does
 * the decode/plan/encode/execute/back-translate work, and this file only binds
 * the source/target wires. Used by xAI, Codex, and other
 * `native_responses`-only providers, and by the dispatch layer when a
 * `/v1/chat/completions` request fails over to a responses-only target.
 */

import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"

import type { AdapterChatResult, AdapterResponsesResult } from "./types"
import { createWireDelegate } from "./wire-delegate"

export const createChatViaResponses = createWireDelegate<
  ChatCompletionsPayload,
  ResponsesPayload,
  AdapterResponsesResult,
  AdapterChatResult
>("chat", "responses")
