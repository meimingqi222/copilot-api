import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import {
  RedactionScope,
  clearMaskMemoForTest,
  maskMemoHitsForTest,
} from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { restoreRedactionStream } from "~/lib/redaction/stream"

const config = redactionConfigSchema.parse({ enabled: true })
const literal = `{{HOME_${"a".repeat(32)}}}`
const command = `printf '%s' '${literal}'`
const args = JSON.stringify({ command })

test("source literals round-trip in tool arguments without granting another caller's mapping", () => {
  const owner = new RedactionScope(config, randomUUID())
  const original = ["/Users", "literal-owner", "work"].join("/")
  const foreign = owner.maskText(original)
  const scope = new RedactionScope(config, randomUUID())
  const input = `Source examples: ${literal} ${foreign}`
  expect(scope.maskText(input)).toBe(input)

  const commands = [command, `printf '%s' '${foreign}'`]
  for (const value of commands) {
    const argumentsJson = JSON.stringify({ command: value })
    for (const call of [
      { type: "tool_use", input: { command: value } },
      { function: { arguments: argumentsJson } },
      { type: "function_call", arguments: argumentsJson },
      { type: "custom_tool_call", input: value },
      { functionCall: { args: { command: value } } },
    ])
      expect(scope.restore(call, "issuer")).toEqual(call)
  }
  expect(scope.diagnostics().restored).toBe(0)
  expect(scope.inspectionMappings([literal, foreign])).toEqual([])
  const unseen = `{{HOME_${"b".repeat(32)}}}`
  expect(() => scope.restoreText(unseen, false, true)).toThrow("Cannot restore")
  const unrelated = new RedactionScope(config, randomUUID())
  expect(() => unrelated.restoreText(literal, false, true)).toThrow(
    "Cannot restore",
  )
})

test("memoized history preserves literal tool-input provenance on every request", () => {
  clearMaskMemoForTest()
  const identity = randomUUID()
  const input = `${"ordinary source line\n".repeat(30)}${literal}`
  const first = new RedactionScope(config, identity)
  expect(first.maskText(input)).toBe(input)
  const next = new RedactionScope(config, identity)
  expect(next.maskText(input)).toBe(input)
  expect(maskMemoHitsForTest()).toBe(1)
  expect(next.restoreText(args, true, true)).toBe(args)
})

test("Responses continuations retain literal provenance without exposing mappings", () => {
  const identity = randomUUID()
  const first = new RedactionScope(config, identity)
  first.maskText(literal)
  const response = {
    id: randomUUID(),
    output: [{ type: "function_call", arguments: args }],
  }
  expect(first.restore(response, "issuer")).toEqual(response)
  const next = new RedactionScope(config, identity)
  next.inheritResponse(response.id)
  expect(next.restoreText(args, true, true)).toBe(args)
  const other = new RedactionScope(config, randomUUID())
  other.inheritResponse(response.id)
  expect(() => other.restoreText(args, true, true)).toThrow("Cannot restore")
})

test("tool argument streams preserve source literals across every placeholder split", async () => {
  for (const wire of [
    "chat",
    "legacy-chat",
    "messages",
    "responses",
    "custom",
    "gemini",
  ]) {
    for (let split = 1; split < args.length; split++) {
      const scope = new RedactionScope(config, randomUUID())
      scope.maskText(literal)
      const chunks = [args.slice(0, split), args.slice(split)]
      const packets =
        wire === "gemini" ?
          [
            {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { name: "bash", args: { command } } },
                    ],
                  },
                },
              ],
            },
          ]
        : chunks.map((chunk) => {
            if (wire === "chat")
              return {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, function: { arguments: chunk } },
                      ],
                    },
                  },
                ],
              }
            if (wire === "legacy-chat")
              return {
                choices: [
                  { index: 0, delta: { function_call: { arguments: chunk } } },
                ],
              }
            if (wire === "messages")
              return {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: chunk },
              }
            return {
              type:
                wire === "custom" ?
                  "response.custom_tool_call_input.delta"
                : "response.function_call_arguments.delta",
              item_id: "tool",
              delta: chunk,
            }
          })
      async function* frames() {
        for (const packet of packets) yield { data: JSON.stringify(packet) }
      }
      const output: any[] = []
      for await (const frame of restoreRedactionStream(
        frames(),
        scope,
        "issuer",
      ))
        output.push(JSON.parse((frame as { data: string }).data))
      const restored = output
        .map((packet) => {
          if (wire === "chat")
            return packet.choices[0].delta.tool_calls[0].function.arguments
          if (wire === "legacy-chat")
            return packet.choices[0].delta.function_call.arguments
          if (wire === "messages") return packet.delta.partial_json
          if (wire === "gemini")
            return JSON.stringify(
              packet.candidates[0].content.parts[0].functionCall.args,
            )
          return packet.delta
        })
        .join("")
      expect(restored).toBe(args)
    }
  }
})

test.each(["SECRET", "PASSWORD", "API_KEY", "HOME", "WORD"])(
  "%s examples remain literal in nested tool-result history",
  (label) => {
    for (const suffix of ["a".repeat(8), "a".repeat(16), "a".repeat(32)]) {
      const token = `{{${label}_${suffix}}}`
      const scope = new RedactionScope(config, randomUUID())
      const history = {
        messages: [
          {
            role: "tool",
            content: [{ type: "text", text: `Source fixture: ${token}` }],
          },
        ],
      }
      expect(scope.mask(history)).toEqual(history)
      const call = {
        type: "tool_use",
        input: { command: `printf '%s' '${token}'` },
      }
      expect(scope.restore(call, "issuer")).toEqual(call)
      expect(scope.diagnostics().restored).toBe(0)
    }
  },
)

test("real mappings still restore alongside source literals in the same tool argument", () => {
  const scope = new RedactionScope(config, randomUUID())
  scope.maskText(literal)
  const original = ["/Users", "current-caller", "work"].join("/")
  const known = scope.maskText(original)
  const call = { type: "tool_use", input: { command: `${known} ${literal}` } }
  expect(scope.restore(call, "issuer")).toEqual({
    type: "tool_use",
    input: { command: `${original} ${literal}` },
  })
  expect(scope.diagnostics().restored).toBe(1)
})
