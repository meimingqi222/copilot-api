import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

/** Emit Chat chunks when the full result had to be buffered before release. */
export async function* streamChatResult(
  result: ChatCompletionResponse,
): AsyncGenerator<CopilotStreamEvent> {
  const base = {
    id: result.id,
    object: "chat.completion.chunk",
    created: result.created,
    model: result.model,
  }
  yield {
    data: JSON.stringify({
      ...base,
      choices: result.choices.map((choice) => ({
        index: choice.index,
        delta: {
          ...choice.message,
          ...(choice.message.tool_calls && {
            tool_calls: choice.message.tool_calls.map((call, index) => ({
              ...call,
              index,
            })),
          }),
        },
        finish_reason: null,
        logprobs: null,
      })),
    }),
  }
  yield {
    data: JSON.stringify({
      ...base,
      ...(result.usage ? { usage: result.usage } : {}),
      choices: result.choices.map((choice) => ({
        index: choice.index,
        delta: {},
        finish_reason: choice.finish_reason,
        logprobs: null,
      })),
    }),
  }
  yield { data: "[DONE]" }
}
