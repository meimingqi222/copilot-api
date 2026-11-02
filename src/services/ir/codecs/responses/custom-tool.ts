/**
 * Responses custom (free-form) tools across wires.
 *
 * Codex offers `apply_patch` (and `exec` in code mode) as `{type: "custom"}`
 * tools whose calls carry free text, not JSON arguments. Chat and Messages
 * have no such tool, so a translated request offers each one as a function
 * taking that text in a single `input` string, and the model's call goes back
 * to the client as the `custom_tool_call` it runs. Without this, a Codex
 * request that fails over to a Chat-only account (e.g. Windsurf serving the
 * same GPT model) is refused locally with "Unsupported Responses input item:
 * custom_tool_call".
 */

import { CustomToolInputDecoder } from "~/services/ir/codecs/responses/custom-tool-input"

import { asRecord, asString } from "~/lib/json-shape"

/** The arguments a custom tool is offered as taking. */
export function customToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The tool's free-form input, the whole of it, exactly as it is to be run.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  }
}

/** A custom tool's description as a function's: its own, how to pass the input, and its grammar. */
export function customToolDescription(tool: Record<string, unknown>): string {
  const own = asString(tool.description)?.trim() ?? ""
  let description =
    (own ? `${own}\n\n` : "")
    + "Put the tool's whole free-form input, as it is to be run, in the `input` string; it is passed on as written, so it is not itself JSON."
  const format = asRecord(tool.format)
  const definition = asString(format?.definition)?.trim()
  if (format?.type === "grammar" && definition) {
    const syntax = asString(format.syntax) || "the"
    description += `\n\nThe input follows this ${syntax} grammar:\n${definition}`
  }
  return description
}

/** Function arguments carrying a custom tool call's free-form input. */
export function customToolArguments(input: string): string {
  return JSON.stringify({ input })
}

/**
 * The free-form input of a call the model made to a custom tool offered as a
 * function: its `input` argument, else a lone JSON string, else the raw text.
 */
export function customToolInput(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed === "string") return parsed
    const input = asRecord(parsed)?.input
    if (typeof input === "string") return input
  } catch {
    /* Not JSON: the model wrote the input itself. */
  }
  return args
}

/** Decode a growing JSON input string, withholding incomplete escapes/surrogates. */
export function customToolInputPrefix(args: string): string | undefined {
  return new CustomToolInputDecoder().push(args)
}
