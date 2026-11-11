type Schema = Record<string, unknown>

const MAP_KEYS = [
  "properties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
]
const SUB_KEYS = [
  "items",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]
const TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Visit schema positions only: defaults, enum values and extension metadata are data.
function eachSchema(value: unknown, visit: (schema: Schema) => void): void {
  const seen = new WeakSet<object>()
  function walk(node: unknown): void {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const schema = node as Schema
    visit(schema)
    for (const key of MAP_KEYS) {
      if (isSchema(schema[key])) Object.values(schema[key]).forEach(walk)
    }
    for (const key of SUB_KEYS) walk(schema[key])
  }
  walk(value)
}

function refTarget(root: Schema, ref: unknown): unknown {
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
    return undefined
  }
  let current: unknown = root
  for (let token of ref.split("/").slice(1)) {
    try {
      token = decodeURIComponent(token)
    } catch {
      return undefined
    }
    token = token.replace(/~1/g, "/").replace(/~0/g, "~")
    if (
      (!isSchema(current) && !Array.isArray(current))
      || !Object.hasOwn(current, token)
    ) {
      return undefined
    }
    current = (current as Schema)[token]
  }
  return current
}

function valueType(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number"
  if (typeof value === "string" || typeof value === "boolean")
    return typeof value
  return Array.isArray(value) ? "array" : "object"
}

function enumType(values: unknown[]): string | string[] | undefined {
  let type: string | undefined
  let nullable = false
  for (const value of values) {
    const next = valueType(value)
    if (next === "null") {
      nullable = true
      continue
    }
    if (next === "array" || next === "object") return undefined
    if (type === undefined || type === next) type = next
    else if ([type, next].every((t) => t === "number" || t === "integer"))
      type = "number"
    else return undefined
  }
  return (
    type === undefined ? undefined
    : nullable ? [type, "null"]
    : type
  )
}

function schemaTypes(
  root: Schema,
  schema: unknown,
  depth = 0,
): Set<string> | undefined {
  if (depth > 16 || !isSchema(schema)) return undefined
  if ("type" in schema) return new Set([schema.type].flat().map(String))
  if ("$ref" in schema)
    return schemaTypes(root, refTarget(root, schema.$ref), depth + 1)
  if (Array.isArray(schema.enum) || "const" in schema) {
    return new Set(
      ("const" in schema ? [schema.const] : (schema.enum as unknown[])).map(
        valueType,
      ),
    )
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    const types = new Set<string>()
    for (const branch of branches) {
      const inferred = schemaTypes(root, branch, depth + 1)
      if (!inferred) {
        if (key !== "allOf") return undefined
        continue
      }
      for (const type of inferred) types.add(type)
    }
    if (types.size) return types
  }
  const keywords: Record<string, string[]> = {
    object: [
      "properties",
      "required",
      "additionalProperties",
      "patternProperties",
      "minProperties",
      "maxProperties",
      "propertyNames",
      "dependentRequired",
      "dependentSchemas",
      "unevaluatedProperties",
    ],
    array: [
      "items",
      "prefixItems",
      "minItems",
      "maxItems",
      "uniqueItems",
      "contains",
      "unevaluatedItems",
    ],
    string: [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "contentEncoding",
      "contentMediaType",
    ],
    number: [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ],
  }
  for (const [type, keys] of Object.entries(keywords)) {
    if (keys.some((key) => key in schema)) return new Set([type])
  }
  return undefined
}

function typeForTarget(
  root: Schema,
  schema: Schema,
): string | string[] | undefined {
  if (Array.isArray(schema.enum)) return enumType(schema.enum)
  if ("const" in schema) return enumType([schema.const])
  const types = schemaTypes(root, schema)
  if (!types?.size) return [...TYPES]
  if (types.has("number")) types.delete("integer")
  const names = TYPES.filter((type) => types.has(type))
  return names.length === 1 ? names[0] : names
}

/**
 * Trae's observed Moonshot tool dialect, not a general JSON Schema lowering.
 * Keep ordinary refs/unions and literal data intact; the caller gates this on Kimi.
 */
export function normalizeTraeToolSchema(schema: Schema): Schema {
  const root = structuredClone(schema)
  eachSchema(root, (node) => {
    if ("$ref" in node && "type" in node) {
      const target = refTarget(root, node.$ref)
      let containsRef = false
      eachSchema(target, (child) => {
        if ("$ref" in child) containsRef = true
      })
      if (isSchema(target) && !containsRef) {
        const own = { ...node }
        delete own.$ref
        for (const key of Object.keys(node)) delete node[key]
        Object.assign(node, structuredClone(target), own)
      } else {
        // Recursive, remote or unresolved references must not be expanded.
        delete node.type
      }
    }
    if (Array.isArray(node.anyOf)) delete node.type
  })
  eachSchema(root, (node) => {
    if ("type" in node || "$ref" in node || Array.isArray(node.anyOf)) return
    const type =
      Array.isArray(node.enum) ? enumType(node.enum)
      : "const" in node ? enumType([node.const])
      : undefined
    if (type !== undefined) node.type = type
  })
  eachSchema(root, (node) => {
    if (typeof node.$ref !== "string") return
    const target = refTarget(root, node.$ref)
    if (
      !isSchema(target)
      || "type" in target
      || "anyOf" in target
      || "$ref" in target
      || !Object.keys(target).length
    )
      return
    const type = typeForTarget(root, target)
    if (type !== undefined) target.type = type
  })
  return root
}
