import type {
  ChatCompletionResponse,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesFunctionCallItem,
  ResponsesMessageItem,
  ResponsesPayload,
  ResponsesReasoningItem,
  ResponsesResponse,
} from "~/services/copilot/responses-api-types"

interface BuildCompletedRequestFieldsInput {
  request?: ResponsesPayload
  reasoningText: string
  toolCalls?: Array<ToolCall>
}

export function buildCompletedResponseBase(input: {
  choice: ChatCompletionResponse["choices"][number]
  output: Array<
    ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesReasoningItem
  >
  outputText: string
  response: ChatCompletionResponse
  usage: ResponsesResponse["usage"]
}): Pick<
  ResponsesResponse,
  | "completed_at"
  | "created_at"
  | "error"
  | "id"
  | "incomplete_details"
  | "model"
  | "object"
  | "output"
  | "output_text"
  | "status"
  | "usage"
> {
  const { choice, output, outputText, response, usage } = input

  return {
    id: response.id,
    object: "response",
    created_at: response.created,
    completed_at: response.created,
    status: "completed",
    error: null,
    model: response.model,
    output,
    output_text: outputText,
    incomplete_details: getIncompleteDetails(choice.finish_reason),
    usage,
  }
}

export function buildCompletedRequestFields(
  input: BuildCompletedRequestFieldsInput,
): Pick<
  ResponsesResponse,
  | "instructions"
  | "max_output_tokens"
  | "metadata"
  | "parallel_tool_calls"
  | "previous_response_id"
  | "reasoning"
  | "store"
  | "temperature"
  | "text"
  | "tool_choice"
  | "tools"
  | "top_p"
  | "truncation"
  | "user"
> {
  const { request, reasoningText, toolCalls } = input

  return {
    ...buildRequestPromptFields(request),
    ...buildRequestSamplingFields(request),
    ...buildRequestToolFields(request, toolCalls),
    reasoning: getResponsesReasoning(request, reasoningText),
  }
}

export function getIncompleteDetails(
  finishReason:
    | ChatCompletionResponse["choices"][number]["finish_reason"]
    | undefined
    | null,
): ResponsesResponse["incomplete_details"] {
  return finishReason === "length" ? { reason: "max_output_tokens" } : null
}

export function getResponsesReasoning(
  request: ResponsesPayload | undefined,
  reasoningText: string,
): ResponsesResponse["reasoning"] {
  return {
    effort: request?.reasoning?.effort ?? null,
    summary:
      reasoningText ? [{ type: "summary_text", text: reasoningText }] : null,
  }
}

function buildRequestPromptFields(
  request: ResponsesPayload | undefined,
): Pick<
  ResponsesResponse,
  | "instructions"
  | "max_output_tokens"
  | "metadata"
  | "previous_response_id"
  | "store"
  | "user"
> {
  return {
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? null,
    previous_response_id: request?.previous_response_id ?? null,
    store: request?.store ?? null,
    user: request?.user ?? null,
    metadata: request?.metadata ?? {},
  }
}

function buildRequestSamplingFields(
  request: ResponsesPayload | undefined,
): Pick<ResponsesResponse, "temperature" | "text" | "top_p" | "truncation"> {
  return {
    temperature: request?.temperature ?? null,
    text: request?.text ?? { format: { type: "text" } },
    top_p: request?.top_p ?? null,
    truncation: request?.truncation ?? null,
  }
}

function buildRequestToolFields(
  request: ResponsesPayload | undefined,
  toolCalls: Array<ToolCall> | undefined,
): Pick<ResponsesResponse, "parallel_tool_calls" | "tool_choice" | "tools"> {
  return {
    parallel_tool_calls:
      request?.parallel_tool_calls ?? (toolCalls?.length ?? 0) > 1,
    tool_choice: request?.tool_choice ?? "auto",
    tools: request?.tools ?? [],
  }
}
