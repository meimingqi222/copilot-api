import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import { HTTPError } from "~/lib/error"

function formatError(message: string, status: number): HTTPError {
  const body = JSON.stringify({
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "upstream_error",
    },
  })
  return new HTTPError(message, new Response(body, { status }), body)
}

/** Use the native strict tool schema, then validate before exposing JSON content. */
export async function createWindsurfStructuredOutput(
  payload: ChatCompletionsPayload,
  execute: (payload: ChatCompletionsPayload) => Promise<ChatCompletionResponse>,
): Promise<ChatCompletionResponse | AsyncIterable<CopilotStreamEvent>> {
  const format = payload.response_format
  const schema =
    format?.type === "json_schema" && "json_schema" in format ?
      format.json_schema.schema
    : { type: "object" }
  // An empty tool schema makes SWE return {} even when the prompt asks for keys.
  // A string envelope lets json_object preserve arbitrary keys without inventing a schema.
  const jsonObject = format?.type === "json_object"
  const toolSchema =
    jsonObject ?
      {
        type: "object",
        properties: {
          json: {
            type: "string",
            description:
              "The complete JSON object answer, encoded as JSON text.",
          },
        },
        required: ["json"],
        additionalProperties: false,
      }
    : schema
  let validate
  try {
    const Compiler =
      typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ?
        Ajv2020
      : Ajv
    const compiler = new Compiler({
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allowUnionTypes: true,
    })
    addFormats(compiler)
    validate = compiler.compile(schema)
  } catch {
    throw formatError("Invalid or unsupported response_format JSON Schema", 400)
  }

  const tools = payload.tools ?? []
  let name = "__structured_output"
  while (tools.some((tool) => tool.function.name === name)) name += "_"
  const realToolsRequired =
    tools.length > 0
    && (payload.tool_choice === "required"
      || (typeof payload.tool_choice === "object"
        && payload.tool_choice !== null))
  const allowRealTools = tools.length > 0 && payload.tool_choice !== "none"
  const result = await execute({
    ...payload,
    response_format: undefined,
    stream: false,
    tools: [
      ...(allowRealTools ? tools : []),
      ...(realToolsRequired ?
        []
      : [
          {
            type: "function" as const,
            function: {
              name,
              description:
                "Return the final answer as JSON matching this schema.",
              parameters: toolSchema,
              strict: true,
            },
          },
        ]),
    ],
    tool_choice:
      realToolsRequired ? payload.tool_choice
      : allowRealTools ? "auto"
      : { type: "function", function: { name } },
  })

  for (const choice of result.choices) {
    const calls = choice.message.tool_calls ?? []
    const output = calls.find((call) => call.function.name === name)
    if (output) {
      if (calls.length !== 1 || choice.finish_reason === "length") {
        throw formatError(
          "Windsurf returned incomplete or mixed structured output",
          502,
        )
      }
      if (jsonObject) {
        try {
          const envelope: unknown = JSON.parse(output.function.arguments)
          if (
            !envelope
            || typeof envelope !== "object"
            || !("json" in envelope)
            || typeof envelope.json !== "string"
          ) {
            throw new Error("Missing JSON envelope")
          }
          choice.message.content = envelope.json
        } catch {
          throw formatError(
            "Windsurf returned invalid JSON output envelope",
            502,
          )
        }
      } else {
        choice.message.content = output.function.arguments
      }
      delete choice.message.tool_calls
      choice.finish_reason = "stop"
    }
    if (!output && calls.length > 0) continue
    let value: unknown
    try {
      if (typeof choice.message.content !== "string")
        throw new Error("Missing JSON")
      value = JSON.parse(choice.message.content)
    } catch {
      throw formatError(
        "Windsurf returned invalid JSON for response_format",
        502,
      )
    }
    if (!validate(value)) {
      throw formatError(
        "Windsurf output does not match response_format JSON Schema",
        502,
      )
    }
  }

  return payload.stream ? streamValidatedResult(result) : result
}

// Buffer structured responses so invalid arguments never escape as successful SSE.
async function* streamValidatedResult(
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
          ...(choice.message.tool_calls ?
            {
              tool_calls: choice.message.tool_calls.map((call, index) => ({
                ...call,
                index,
              })),
            }
          : {}),
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
