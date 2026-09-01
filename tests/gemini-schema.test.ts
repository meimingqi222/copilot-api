import { describe, expect, test } from "bun:test"

import { cleanJsonSchemaForAntigravityTool } from "~/lib/gemini-schema"

describe("cleanJsonSchemaForAntigravityTool", () => {
  test("移除 $schema 字段", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        name: { type: "string" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.$schema).toBeUndefined()
    expect(result.type).toBe("object")
    expect((result.properties as Record<string, unknown>).name).toBeDefined()
  })

  test("移除 propertyNames 字段", () => {
    const schema = {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      properties: {
        name: { type: "string" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.propertyNames).toBeUndefined()
  })

  test("移除 additionalProperties 字段并添加提示", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.additionalProperties).toBeUndefined()
    expect(result.description).toContain("No extra properties allowed")
  })

  test("内联 $ref 引用", () => {
    const schema = {
      $defs: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
        },
      },
      type: "object",
      properties: {
        home: { $ref: "#/$defs/address" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.$defs).toBeUndefined()
    const props = result.properties as Record<string, unknown>
    const home = props.home as Record<string, unknown>
    expect(home.$ref).toBeUndefined()
    expect(home.type).toBe("object")
    const homeProps = home.properties as Record<string, unknown>
    expect(homeProps.street).toBeDefined()
    expect(homeProps.city).toBeDefined()
  })

  test("合并 allOf", () => {
    const schema = {
      type: "object",
      allOf: [
        {
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        {
          properties: {
            age: { type: "number" },
          },
          required: ["age"],
        },
      ],
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.allOf).toBeUndefined()
    const props = result.properties as Record<string, unknown>
    expect(props.name).toBeDefined()
    expect(props.age).toBeDefined()
    expect(result.required).toEqual(["name", "age"])
  })

  test("扁平化 anyOf 选择最强分支", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "null" }],
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.anyOf).toBeUndefined()
    expect(result.type).toBe("string")
    expect(result.nullable).toBe(true)
  })

  test("扁平化 type 数组", () => {
    const schema = {
      type: ["string", "null"],
      description: "A nullable string",
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(Array.isArray(result.type)).toBe(false)
    expect(result.type).toBe("string")
    expect(result.description).toContain("nullable")
  })

  test("const 转换为 enum 后移到 description（dropAllEnums）", () => {
    const schema = {
      type: "string",
      const: "hello",
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    // const 先转为 enum，再因 dropAllEnums 移到 description
    expect(result.const).toBeUndefined()
    expect(result.enum).toBeUndefined()
    expect(result.description).toContain("Allowed: hello")
  })

  test("约束移到 description", () => {
    const schema = {
      type: "string",
      minLength: 5,
      maxLength: 100,
      pattern: "^[a-z]+$",
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.minLength).toBeUndefined()
    expect(result.maxLength).toBeUndefined()
    expect(result.pattern).toBeUndefined()
    expect(result.description).toContain("minLength: 5")
    expect(result.description).toContain("maxLength: 100")
    expect(result.description).toContain("pattern: ^[a-z]+$")
  })

  test("移除 x-* 扩展字段", () => {
    const schema = {
      type: "object",
      "x-google-enum-descriptions": ["a", "b"],
      properties: {
        name: { type: "string" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result["x-google-enum-descriptions"]).toBeUndefined()
  })

  test("保留 properties 中的字段名不被误删", () => {
    // 一个属性名为 "propertyNames" 的工具不应被删除
    const schema = {
      type: "object",
      properties: {
        propertyNames: { type: "array", items: { type: "string" } },
        additionalProperties: { type: "boolean" },
      },
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    const props = result.properties as Record<string, unknown>
    // properties 内的键是属性名，不应被当作 schema 关键字删除
    expect(props.propertyNames).toBeDefined()
    expect(props.additionalProperties).toBeDefined()
  })

  test("空 object schema 添加占位符", () => {
    const schema = {
      type: "object",
      properties: {},
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    const props = result.properties as Record<string, unknown>
    expect(props.reason).toBeDefined()
    expect(result.required).toEqual(["reason"])
  })

  test("数组类型缺少 items 时补充", () => {
    const schema = {
      type: "array",
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.items).toBeDefined()
    const items = result.items as Record<string, unknown>
    expect(items.type).toBe("string")
  })

  test("清理 required 中不存在的属性", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name", "nonexistent"],
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.required).toEqual(["name"])
  })

  test("复杂嵌套 schema 正确清理", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        config: {
          type: "object",
          additionalProperties: false,
          propertyNames: { pattern: "^[a-z]+$" },
          properties: {
            timeout: {
              type: "integer",
              minimum: 0,
              maximum: 300,
            },
          },
        },
        tags: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
        },
      },
      required: ["config"],
    }
    const result = cleanJsonSchemaForAntigravityTool(schema, true) as Record<
      string,
      unknown
    >
    expect(result.$schema).toBeUndefined()

    const props = result.properties as Record<string, unknown>
    const config = props.config as Record<string, unknown>
    expect(config.additionalProperties).toBeUndefined()
    expect(config.propertyNames).toBeUndefined()
    expect(config.description).toContain("No extra properties allowed")

    const configProps = config.properties as Record<string, unknown>
    const timeout = configProps.timeout as Record<string, unknown>
    expect(timeout.minimum).toBeUndefined()
    expect(timeout.maximum).toBeUndefined()
    expect(timeout.description).toContain("minimum: 0")
    expect(timeout.description).toContain("maximum: 300")

    const tags = props.tags as Record<string, unknown>
    const items = tags.items as Record<string, unknown>
    expect(items.minLength).toBeUndefined()
    expect(items.description).toContain("minLength: 1")
  })
})
