import { describe, expect, test } from "bun:test"

import { traeCnChatBody } from "~/services/trae-cn/client"
import { normalizeTraeToolSchema } from "~/services/trae-cn/tool-schema"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

function toolParameters(
  parameters: Record<string, unknown>,
  upstreamModel: string,
  modelName?: string,
): Record<string, unknown> {
  const payload: ChatCompletionsPayload = {
    model: "kimi-client-alias",
    messages: [{ role: "user", content: "Use the tool" }],
    tools: [{ type: "function", function: { name: "edit", parameters } }],
  }
  const body = traeCnChatBody(payload, "chat_v3", upstreamModel, modelName)
  const tools = body.tools as Array<{
    function: { parameters: string; name: string }
  }>
  expect(tools[0].function.name).toBe("edit")
  expect(typeof tools[0].function.parameters).toBe("string")
  return JSON.parse(tools[0].function.parameters) as Record<string, unknown>
}

describe("Trae Kimi schema integration", () => {
  const schema = {
    type: "object",
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { enum: ["add", "remove"], description: "Operation" },
            value: { type: "string", anyOf: [{ const: "x" }, { const: null }] },
          },
        },
      },
    },
  }
  const expected = {
    type: "object",
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add", "remove"],
              description: "Operation",
            },
            value: { anyOf: [{ type: "string", const: "x" }, { const: null }] },
          },
        },
      },
    },
  }

  test.each([
    ["KIMI-K2.5", undefined],
    ["moonshot-v1", undefined],
    ["opaque-config", "Moonshot-Kimi__dev"],
    ["kimi-config", "other-display-name"],
  ])("normalizes nested tool schemas for %s / %s", (model, name) => {
    const before = structuredClone(schema)
    expect(toolParameters(schema, model!, name)).toEqual(expected)
    expect(schema).toEqual(before)
  })

  test("does not normalize other upstreams or match a client alias", () => {
    expect(toolParameters(schema, "deepseek-v4", "DeepSeek__dev")).toEqual(
      schema,
    )
    expect(toolParameters(schema, "doubao")).toEqual(schema)
  })

  test("leaves an already accepted schema unchanged on Kimi", () => {
    const accepted = {
      type: "object",
      properties: { op: { type: "string", enum: ["add", "remove"] } },
      required: ["op"],
      additionalProperties: false,
    }
    expect(toolParameters(accepted, "kimi")).toEqual(accepted)
  })

  test("normalizes local refs without changing the request's definitions or metadata", () => {
    const input = {
      type: "object",
      $defs: { "op/~": { enum: ["add", "remove"], title: "Operation" } },
      properties: {
        op: { $ref: "#/$defs/op~1~0", type: "string", description: "Choose" },
      },
      default: { type: "string", anyOf: [{ const: "literal" }] },
      examples: [{ enum: ["literal"], properties: { op: { const: "x" } } }],
    }
    const before = structuredClone(input)
    const output = toolParameters(input, "kimi")
    expect(output.properties).toEqual({
      op: {
        type: "string",
        enum: ["add", "remove"],
        title: "Operation",
        description: "Choose",
      },
    })
    expect(output.default).toEqual(input.default)
    expect(output.examples).toEqual(input.examples)
    expect(input).toEqual(before)
  })
})

describe("normalizeTraeToolSchema", () => {
  test.each([
    [{ enum: ["a", "b"] }, "string"],
    [{ enum: [false, true] }, "boolean"],
    [{ enum: [1, 2] }, "integer"],
    [{ enum: [1, 2.5] }, "number"],
    [{ enum: [2.5, 1] }, "number"],
    [{ enum: [null, "a"] }, ["string", "null"]],
    [{ enum: [1, null, 2.5] }, ["number", "null"]],
    [{ const: false }, "boolean"],
    [{ const: 0 }, "integer"],
    [{ const: 0.5 }, "number"],
    [{ const: "" }, "string"],
  ] as Array<[Record<string, unknown>, string | string[]]>)(
    "infers homogeneous enum/const types: %j",
    (input, type) => {
      const before = structuredClone(input)
      expect(normalizeTraeToolSchema(input)).toEqual({ ...input, type })
      expect(input).toEqual(before)
    },
  )

  test.each([
    { enum: [] },
    { enum: [null] },
    { const: null },
    { enum: [1, "one"] },
    { enum: [{ const: "data" }] },
    { const: { enum: ["data"] } },
    { enum: [["data"]] },
    { enum: ["a"], type: "string", default: "a" },
    { type: ["string", "null"], enum: [null, "a"] },
    { oneOf: [{ type: "string" }, { type: "integer" }] },
  ])("does not guess or flatten accepted schemas: %j", (input) => {
    expect(normalizeTraeToolSchema(input)).toEqual(input)
  })

  test("does not reintroduce type beside anyOf, including with enum/const", () => {
    for (const extra of [{}, { enum: ["a"] }, { const: "a" }]) {
      const input = { type: "string", anyOf: [{ type: "string" }], ...extra }
      const output = normalizeTraeToolSchema(input)
      expect(output).toEqual({ anyOf: input.anyOf, ...extra })
      expect(normalizeTraeToolSchema(output)).toEqual(output)
    }
  })

  test("visits schema positions, not property names, enum/examples/default or extensions", () => {
    const literal = {
      type: "string",
      anyOf: [{ const: "leave alone" }],
      enum: ["data"],
    }
    const input = {
      type: "object",
      properties: {
        enum: { const: "enum" },
        default: { const: "default" },
        anyOf: { const: "anyOf" },
        $ref: { const: "$ref" },
        properties: { const: "properties" },
      },
      default: literal,
      examples: [literal],
      enum: [literal],
      "x-vendor": literal,
    }
    const before = structuredClone(input)
    const output = normalizeTraeToolSchema(input)
    expect(output.properties).toEqual(
      Object.fromEntries(
        Object.entries(input.properties).map(([name, value]) => [
          name,
          { ...value, type: "string" },
        ]),
      ),
    )
    for (const key of ["default", "examples", "enum", "x-vendor"]) {
      expect(output[key]).toEqual((input as Record<string, unknown>)[key])
    }
    expect(input).toEqual(before)
  })

  test("walks nested schema maps, tuple items and composition without flattening", () => {
    const input = {
      dependentSchemas: { foo: { const: true } },
      patternProperties: { "^x": { enum: [1] } },
      additionalProperties: { const: "extra" },
      items: [{ const: "tuple" }],
      prefixItems: [{ const: 1 }],
      allOf: [{ properties: { nested: { oneOf: [{ const: "a" }] } } }],
      if: { const: true },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a Promise method.
      then: { const: "yes" },
      else: false,
      contains: { const: 2 },
      not: { const: false },
    }
    const output = normalizeTraeToolSchema(input)
    expect(output).toEqual({
      dependentSchemas: { foo: { type: "boolean", const: true } },
      patternProperties: { "^x": { type: "integer", enum: [1] } },
      additionalProperties: { type: "string", const: "extra" },
      items: [{ type: "string", const: "tuple" }],
      prefixItems: [{ type: "integer", const: 1 }],
      allOf: [
        { properties: { nested: { oneOf: [{ type: "string", const: "a" }] } } },
      ],
      if: { type: "boolean", const: true },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a Promise method.
      then: { type: "string", const: "yes" },
      else: false,
      contains: { type: "integer", const: 2 },
      not: { type: "boolean", const: false },
    })
  })

  test("adds types to referenced untyped targets without expanding ordinary refs", () => {
    const input = {
      definitions: {
        object: { properties: { op: { const: "add" } } },
        array: { items: { type: "string" } },
        numeric: { minimum: 0 },
        text: { minLength: 1 },
        empty: {},
        union: { anyOf: [{ const: "x" }, { const: 1 }] },
      },
      properties: Object.fromEntries(
        ["object", "array", "numeric", "text", "empty", "union"].map((name) => [
          name,
          { $ref: `#/definitions/${name}` },
        ]),
      ),
    }
    const output = normalizeTraeToolSchema(input)
    const definitions = output.definitions as Record<
      string,
      Record<string, unknown>
    >
    expect(definitions.object.type).toBe("object")
    expect(definitions.array.type).toBe("array")
    expect(definitions.numeric.type).toBe("number")
    expect(definitions.text.type).toBe("string")
    expect(definitions.empty).toEqual({})
    expect(definitions.union).not.toHaveProperty("type")
    expect(output.properties).toEqual(input.properties)
    expect(input.definitions.object).not.toHaveProperty("type")
  })

  test("handles recursive, mutual, unresolved and remote refs without expanding them", () => {
    const input = {
      type: "object",
      $defs: {
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node", type: "object" } },
        },
        a: { $ref: "#/$defs/b", type: "string" },
        b: { $ref: "#/$defs/a", type: "string" },
      },
      properties: {
        self: { $ref: "#", type: "object" },
        remote: { $ref: "https://example.com/schema", type: "object" },
        missing: { $ref: "#/$defs/missing", type: "string" },
        node: { $ref: "#/$defs/node", type: "object" },
      },
    }
    const before = structuredClone(input)
    const output = normalizeTraeToolSchema(input)
    expect(output.properties).toEqual(
      Object.fromEntries(
        Object.entries(input.properties).map(([name, value]) => [
          name,
          { $ref: value.$ref },
        ]),
      ),
    )
    expect((output.$defs as Record<string, unknown>).a).toEqual({
      $ref: "#/$defs/b",
    })
    expect((output.$defs as Record<string, unknown>).b).toEqual({
      $ref: "#/$defs/a",
    })
    expect(normalizeTraeToolSchema(output)).toEqual(output)
    expect(input).toEqual(before)
    expect(() => JSON.stringify(output)).not.toThrow()
  })

  test("resolves escaped/percent encoded local refs and preserves sibling metadata", () => {
    const input = {
      $defs: {
        "a/b~ c": { type: "string", minLength: 1, description: "base" },
      },
      properties: {
        key: {
          $ref: "#/$defs/a~1b~0%20c",
          type: "string",
          description: "own",
          default: "ok",
        },
      },
    }
    expect(normalizeTraeToolSchema(input).properties).toEqual({
      key: { type: "string", minLength: 1, description: "own", default: "ok" },
    })
  })
})
