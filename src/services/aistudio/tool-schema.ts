import { LocalPayloadUnsupportedError } from "~/lib/error"

// Playground schema slots, matching AIStudio2API's schema.go.
const scalarFields: Record<string, number> = {
  format: 1,
  description: 2,
  nullable: 3,
  enum: 4,
  required: 7,
  minProperties: 8,
  maxProperties: 9,
  minimum: 10,
  maximum: 11,
  minLength: 12,
  maxLength: 13,
  pattern: 14,
  maxItems: 20,
  minItems: 21,
  propertyOrdering: 22,
}
const variantFields: Record<string, number> = {
  oneOf: 16,
  anyOf: 17,
  allOf: 18,
}
const metadataFields = new Set(["$schema", "$id", "$comment", "title"])
const promptedFields = new Set([
  "additionalProperties",
  "propertyNames",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "default",
])
const typeCodes: Record<string, number> = {
  string: 1,
  number: 2,
  integer: 3,
  boolean: 4,
  array: 5,
  object: 6,
}

function unsupported(message: string): never {
  throw new LocalPayloadUnsupportedError(`AI Studio: ${message}`)
}

function schemaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unsupported("schema must be an object")
  return value as Record<string, unknown>
}

interface SchemaState {
  prompted: boolean
}

function normalizeNullable(
  value: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ["anyOf", "oneOf"]) {
    const branches = value[key]
    if (!Array.isArray(branches) || branches.length !== 2) continue
    const nullIndex = branches.findIndex((branch: unknown) => {
      if (!branch || typeof branch !== "object" || Array.isArray(branch))
        return false
      const schema = branch as Record<string, unknown>
      return schema.type === "null" && Object.keys(schema).length === 1
    })
    if (nullIndex === -1) continue
    const rest = { ...value }
    delete rest[key]
    return { ...schemaObject(branches[1 - nullIndex]), ...rest, nullable: true }
  }
  return value
}

function encodeSchema(input: unknown, state: SchemaState): unknown[] {
  const value = normalizeNullable(schemaObject(input))
  const wire: unknown[] = []
  for (const [key, item] of Object.entries(value)) {
    if (metadataFields.has(key) || key === "type") continue
    if (promptedFields.has(key)) {
      state.prompted = true
      continue
    }
    const slot =
      Object.hasOwn(scalarFields, key) ? scalarFields[key] : undefined
    if (slot !== undefined) {
      wire[slot] = item
    } else if (key === "items") {
      wire[5] = encodeSchema(item, state)
    } else if (key === "properties") {
      wire[6] = Object.entries(schemaObject(item)).map(([name, child]) => [
        name,
        encodeSchema(child, state),
      ])
    } else if (Object.hasOwn(variantFields, key)) {
      if (!Array.isArray(item) || !item.length)
        unsupported(`schema ${key} must be a nonempty array`)
      wire[variantFields[key]] = item.map((child) => encodeSchema(child, state))
    } else {
      unsupported(`unsupported field ${key}`)
    }
  }
  if (
    value.enum !== undefined
    && (!Array.isArray(value.enum)
      || !value.enum.every((v) => typeof v === "string"))
  )
    unsupported("only string schema enums are supported")
  let type = value.type
  if (type === undefined) {
    if (
      value.properties !== undefined
      || value.additionalProperties !== undefined
    )
      type = "object"
    else if (value.items !== undefined) type = "array"
    else if (value.enum !== undefined) type = "string"
  }
  if (type !== undefined) {
    wire[0] = typeCodes[String(type).toLowerCase()]
  } else {
    // A union without a root type still needs a concrete Playground carrier.
    for (const slot of Object.values(variantFields)) {
      const first = (wire[slot] as unknown[][] | undefined)?.[0]
      if (!first) continue
      wire[0] = first[0]
      if (first[0] === 5 && wire[5] === undefined) wire[5] = first[5]
      break
    }
  }
  if (typeof wire[0] !== "number")
    unsupported("schema requires a supported explicit type")
  return wire
}

/** Unsupported constraints remain model instructions, not server validation. */
export function encodeAIStudioToolSchema(
  parameters: Record<string, unknown>,
  description?: string,
): { wire: unknown[]; description: string | undefined } {
  const state: SchemaState = { prompted: false }
  const wire = encodeSchema(parameters, state)
  return {
    wire,
    description:
      state.prompted ?
        `${description ?? ""}\nArguments must follow this JSON Schema: ${JSON.stringify(parameters)}`
      : description,
  }
}
