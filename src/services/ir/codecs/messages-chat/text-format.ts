import type { RequestIR } from "~/services/ir/types"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

export function decodeChatTextFormat(
  format: ChatCompletionsPayload["response_format"],
): NonNullable<RequestIR["generation"]>["textFormat"] {
  if (!format) return undefined
  if (format.type === "json_schema")
    return { type: "json_schema", jsonSchema: format.json_schema }
  return { type: format.type }
}

export function encodeChatTextFormat(
  format: NonNullable<RequestIR["generation"]>["textFormat"],
): Pick<ChatCompletionsPayload, "response_format"> {
  if (!format) return {}
  if (format.type !== "json_schema")
    return { response_format: { type: format.type } }
  const schema = (format.jsonSchema.schema ?? format.jsonSchema) as Record<
    string,
    unknown
  >
  return {
    response_format: {
      type: "json_schema",
      json_schema: {
        name:
          typeof format.jsonSchema.name === "string" ?
            format.jsonSchema.name
          : "response",
        ...(typeof format.jsonSchema.description === "string" && {
          description: format.jsonSchema.description,
        }),
        ...(typeof format.jsonSchema.strict === "boolean" && {
          strict: format.jsonSchema.strict,
        }),
        schema,
      },
    },
  }
}
