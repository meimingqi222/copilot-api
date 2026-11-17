import { describe, expect, test } from "bun:test"

import { normalizeWindsurfToolSchema } from "~/services/windsurf/tool-schema"

const normalize = (schema: unknown, model = "claude-sonnet") =>
  normalizeWindsurfToolSchema(schema, model)

describe("Windsurf tool schemas", () => {
  test("folds asymmetric object alternatives without choosing the first field schema", () => {
    const schema = {
      title: "tool",
      properties: { root: { type: "boolean" } },
      required: ["root"],
      allOf: [{ properties: { base: { type: "string" } }, required: ["base"] }],
      oneOf: [
        {
          type: "object",
          properties: { id: { type: "string" }, create: { const: true } },
          required: ["id", "create"],
        },
        {
          type: "object",
          properties: { id: { type: "integer" }, update: { const: true } },
          required: ["id", "update"],
        },
        { type: "null" },
      ],
    }
    const before = structuredClone(schema)
    expect(normalize(schema)).toEqual({
      type: "object",
      title: "tool",
      properties: {
        root: { type: "boolean" },
        base: { type: "string" },
        id: { anyOf: [{ type: "string" }, { type: "integer" }] },
        create: { const: true },
        update: { const: true },
      },
      required: ["root", "base", "id"],
    })
    expect(schema).toEqual(before)
  })

  test("resolves local definitions and nested unions with common required fields", () => {
    const schema = {
      $defs: {
        nested: {
          anyOf: [
            {
              type: "object",
              properties: { id: { type: "string" }, a: {} },
              required: ["id", "a"],
            },
            {
              type: "object",
              properties: { id: { type: "string" }, b: {} },
              required: ["id", "b"],
            },
          ],
        },
      },
      definitions: { base: { properties: { base: {} }, required: ["base"] } },
      allOf: [{ $ref: "#/definitions/base" }],
      anyOf: [
        { $ref: "#/$defs/nested" },
        {
          type: "object",
          properties: { id: { type: "string" }, c: {} },
          required: ["id", "c"],
        },
        { $ref: "https://unresolved" },
      ],
    }
    expect(normalize(schema)).toMatchObject({
      type: "object",
      properties: { base: {}, id: { type: "string" }, a: {}, b: {}, c: {} },
      required: ["base", "id"],
    })
    expect(normalize(schema)).not.toHaveProperty("anyOf")
  })

  test("bounds recursive union refs and folds nested allOf", () => {
    const schema = {
      $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }] } },
      anyOf: [{ $ref: "#/$defs/loop" }],
    }
    expect(normalize(schema)).toMatchObject({ type: "object", properties: {} })
    expect(
      normalize({
        allOf: [{ allOf: [{ properties: { x: {} }, required: ["x"] }] }],
      }),
    ).toEqual({ type: "object", properties: { x: {} }, required: ["x"] })
  })

  test("leaves non-Gemini nested schemas intact, including nullable and tuple items", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        value: {
          type: ["string", "null"],
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        },
        tuple: {
          type: "array",
          items: [{ type: "string" }, { type: "integer" }],
        },
        ref: { $ref: "#/$defs/value" },
      },
      $defs: { value: { enum: [1, 2] } },
    }
    expect(normalize(schema)).toEqual(schema)
    expect(normalize(schema, "swe-2")).toEqual(schema)
  })

  test("repairs Gemini nested nullable types, typed anyOf and array items without mutation", () => {
    const schema = {
      type: "object",
      properties: {
        optional: {
          type: ["integer", "null"],
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
        },
        choices: { type: "integer", anyOf: [{ const: 1 }, { const: 2 }] },
        both: {
          type: "integer",
          oneOf: [{ minimum: 0 }],
          anyOf: [{ const: 1 }, { const: 2 }],
        },
        missing: { type: "array" },
        yes: { type: "array", items: true },
        no: { type: "array", items: false },
        single: { items: [{ type: ["string", "null"] }] },
        tuple: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
        union: { type: ["string", "array", "null"] },
      },
    }
    const before = structuredClone(schema)
    expect(normalize(schema, "Devin-GEMINI-4").properties).toEqual({
      optional: { type: "integer", nullable: true, minimum: 1 },
      choices: { type: "integer", oneOf: [{ const: 1 }, { const: 2 }] },
      both: {
        type: "integer",
        oneOf: [{ minimum: 0 }],
        allOf: [{ oneOf: [{ const: 1 }, { const: 2 }] }],
      },
      missing: { type: "array", items: {} },
      yes: { type: "array", items: {} },
      no: { type: "array", items: {} },
      single: { type: "array", items: { type: "string", nullable: true } },
      tuple: { type: "array", items: {} },
      union: {
        nullable: true,
        anyOf: [{ type: "string" }, { type: "array", items: {} }],
      },
    })
    expect(schema).toEqual(before)
  })

  test("infers Gemini enums and objects while retaining untyped unions and constraints", () => {
    const schema = {
      properties: {
        name: { enum: ["a", null] },
        count: { enum: [1, 1.5] },
        flag: { enum: [true, false] },
        mixed: { enum: ["a", 1] },
        nil: { type: ["null"] },
        empty: { type: [] },
        object: {
          properties: { x: { type: "array" } },
          additionalProperties: false,
        },
        union: { anyOf: [{ type: "string" }, { type: "number" }] },
        one: { type: "string", oneOf: [{ minLength: 1 }] },
      },
    }
    expect(normalize(schema, "gemini").properties).toEqual({
      name: { type: "string", enum: ["a"], nullable: true },
      count: { type: "number", enum: [1, 1.5] },
      flag: { type: "boolean", enum: [true, false] },
      mixed: {},
      nil: { type: "null" },
      empty: {},
      object: {
        type: "object",
        properties: { x: { type: "array", items: {} } },
        additionalProperties: false,
      },
      union: { anyOf: [{ type: "string" }, { type: "number" }] },
      one: { type: "string", oneOf: [{ minLength: 1 }] },
    })
  })

  test("repairs schemas under all supported recursive Gemini keywords", () => {
    const nullable = { type: ["string", "null"] }
    const schema = {
      type: "object",
      patternProperties: { x: nullable },
      $defs: { x: nullable },
      definitions: { x: nullable },
      dependentSchemas: { x: nullable },
      additionalProperties: nullable,
      not: nullable,
      if: nullable,
      // JSON Schema's conditional keyword, not a Promise-like object.
      // oxlint-disable-next-line unicorn/no-thenable
      then: nullable,
      else: nullable,
      contains: nullable,
      prefixItems: [nullable],
      properties: { x: { allOf: [nullable] } },
    }
    const result = normalize(schema, "gemini")
    for (const key of [
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
    ])
      expect(result[key]).toEqual({ x: { type: "string", nullable: true } })
    for (const key of [
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
      "contains",
    ])
      expect(result[key]).toEqual({ type: "string", nullable: true })
    expect(result.prefixItems).toEqual([{ type: "string", nullable: true }])
    expect(result.properties).toEqual({
      x: { allOf: [{ type: "string", nullable: true }] },
    })
  })

  test("falls back to an object for invalid parameter roots", () => {
    for (const value of [null, undefined, true, [], "bad", 1])
      expect(normalize(value)).toEqual({ type: "object", properties: {} })
  })
})
