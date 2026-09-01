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
    // If reasoning_content already carries text, nothing to do. An empty
    // string counts as absent, matching `extractReasoningTextAlias`: upstreams
    // routinely emit `reasoning_content: ""` alongside the spelling that does
    // hold the reasoning, and short-circuiting on it would hand the client an
    // empty field while the real text sits one alias away.
    if (delta.reasoning_content) {
      return choice
    }
    // Map the first non-null alias to reasoning_content.
    const reasoningContent = extractReasoningTextAlias(delta)
    if (reasoningContent === undefined) {
      return choice
    }
    return {
      ...choice,
      delta: { ...delta, reasoning_content: reasoningContent },
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
    // Empty string counts as absent — see `normalizeChunk`.
    if (message.reasoning_content) {
      return choice
    }
    const reasoningContent = extractReasoningTextAlias(message)
    if (reasoningContent === undefined) {
      return choice
    }
    return {
      ...choice,
      message: { ...message, reasoning_content: reasoningContent },
    }
  })

  return { ...response, choices: normalizedChoices }
}
