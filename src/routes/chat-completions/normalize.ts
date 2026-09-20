import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import { extractReasoningTextAlias } from "~/lib/thinking"

/**
 * Normalizes a streaming ChatCompletionChunk so that non-standard reasoning
 * field aliases used by the upstream Copilot API are mapped to the standard
 * OpenAI `reasoning_content` field that OpenAI-compatible clients expect.
 *
 * The Copilot upstream returns `reasoning_text` (and optionally
 * `reasoning_opaque` for the Anthropic signature) rather than the standard
 * `reasoning_content` field used by DeepSeek, OpenRouter, etc. This function
 * fills in `reasoning_content` when it is absent so that standard clients
 * (e.g. the fantasy openai-compat provider used by crush) can display
 * thinking content correctly.
 */
export function normalizeChunk(
  chunk: ChatCompletionChunk,
): ChatCompletionChunk {
  if (!chunk.choices?.length) {
    return chunk
  }

  const normalizedChoices = chunk.choices.map((choice) => {
    const { delta } = choice
    // Whether an alias *key* is present, not whether it carries text: an
    // explicit `""`/`null` still has to be stripped after the canonical field
    // is filled (its value is absent, so `extractReasoningTextAlias` skips it).
    const hasReasoningAliasKey =
      delta.reasoning_text !== undefined
      || delta.reasoning !== undefined
      || delta.thinking !== undefined
    // Map the first non-null alias to reasoning_content, then drop the source
    // alias fields: they now hold the identical text, and a client that reads
    // every reasoning-like field would render the thinking twice. Canonical
    // `reasoning_content` wins over the aliases, matching
    // `extractReasoningTextAlias`'s consumers and `sse-aggregate`.
    const reasoningContent =
      delta.reasoning_content || extractReasoningTextAlias(delta)
    if (reasoningContent === undefined) {
      return choice
    }
    if (!hasReasoningAliasKey && delta.reasoning_content === reasoningContent) {
      return choice
    }
    const nextDelta = { ...delta, reasoning_content: reasoningContent }
    delete nextDelta.reasoning_text
    delete nextDelta.reasoning
    delete nextDelta.thinking
    return {
      ...choice,
      delta: nextDelta,
    }
  })

  return { ...chunk, choices: normalizedChoices }
}

/**
 * Normalizes a non-streaming ChatCompletionResponse so that non-standard
 * reasoning field aliases are mapped to the standard `reasoning_content` field.
 */
export function normalizeResponse(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  if (response.choices.length === 0) {
    return response
  }

  const normalizedChoices = response.choices.map((choice) => {
    const { message } = choice
    // Same alias-key check as `normalizeChunk` — see the comment there.
    const hasReasoningAliasKey =
      message.reasoning_text !== undefined
      || message.reasoning !== undefined
      || message.thinking !== undefined
    const reasoningContent =
      message.reasoning_content || extractReasoningTextAlias(message)
    if (reasoningContent === undefined) {
      return choice
    }
    if (
      !hasReasoningAliasKey
      && message.reasoning_content === reasoningContent
    ) {
      return choice
    }
    // Same dedup as `normalizeChunk`: the source alias now duplicates
    // reasoning_content verbatim.
    const nextMessage = { ...message, reasoning_content: reasoningContent }
    delete nextMessage.reasoning_text
    delete nextMessage.reasoning
    delete nextMessage.thinking
    return {
      ...choice,
      message: nextMessage,
    }
  })

  return { ...response, choices: normalizedChoices }
}
