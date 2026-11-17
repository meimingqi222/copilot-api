type Schema = Record<string, unknown>

const unions = ["anyOf", "oneOf", "allOf"] as const
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const requiredFields = (schema: Schema): string[] =>
  Array.isArray(schema.required) ?
    schema.required.filter(
      (field): field is string => typeof field === "string",
    )
  : []

function resolveBranch(root: Schema, branch: unknown): Schema | undefined {
  if (!isObject(branch)) return undefined
  if (typeof branch.$ref !== "string" || !branch.$ref) return branch
  for (const key of ["$defs", "definitions"]) {
    const prefix = `#/${key}/`
    if (!branch.$ref.startsWith(prefix)) continue
    const definitions = root[key]
    const target =
      isObject(definitions) ?
        definitions[branch.$ref.slice(prefix.length)]
      : undefined
    return isObject(target) ? target : undefined
  }
  return undefined
}

function foldRoot(root: Schema, schema: Schema, depth = 0): Schema {
  if (
    schema.type === "object"
    && !unions.some((key) => Object.hasOwn(schema, key))
  )
    return schema
  const out = { ...schema }
  const properties: Schema = {
    ...(isObject(schema.properties) ? schema.properties : {}),
  }
  const required = requiredFields(schema)
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    const resolved = resolveBranch(root, branch)
    if (!resolved) continue
    const folded =
      depth < 8 && unions.some((key) => Object.hasOwn(resolved, key)) ?
        foldRoot(root, resolved, depth + 1)
      : resolved
    for (const [key, value] of Object.entries(
      isObject(folded.properties) ? folded.properties : {},
    )) {
      if (!Object.hasOwn(properties, key)) properties[key] = value
    }
    required.push(...requiredFields(folded))
  }
  delete out.allOf
  const branches: Schema[] = []
  for (const key of ["anyOf", "oneOf"]) {
    for (const branch of Array.isArray(schema[key]) ? schema[key] : []) {
      const resolved = resolveBranch(root, branch)
      if (!resolved) continue
      const folded =
        depth < 8 && unions.some((union) => Object.hasOwn(resolved, union)) ?
          foldRoot(root, resolved, depth + 1)
        : resolved
      if (folded.type === "object" || Object.hasOwn(folded, "properties"))
        branches.push(folded)
    }
    delete out[key]
  }
  mergeAlternatives(properties, required, branches)
  out.type = "object"
  out.properties = properties
  if (required.length) out.required = [...new Set(required)]
  else delete out.required
  return out
}

function mergeAlternatives(
  properties: Schema,
  required: string[],
  branches: Schema[],
): void {
  let common: string[] | undefined
  const alternatives = new Map<string, unknown[]>()
  for (const branch of branches) {
    for (const [key, value] of Object.entries(
      isObject(branch.properties) ? branch.properties : {},
    )) {
      if (Object.hasOwn(properties, key)) continue
      const values = alternatives.get(key) ?? []
      if (
        !values.some((other) => JSON.stringify(other) === JSON.stringify(value))
      )
        values.push(value)
      alternatives.set(key, values)
    }
    const fields = requiredFields(branch)
    common =
      common === undefined ? fields : common.filter((r) => fields.includes(r))
  }
  for (const [key, values] of alternatives)
    properties[key] = values.length === 1 ? values[0] : { anyOf: values }
  required.push(...(common ?? []))
}

function normalizeTypeList(out: Schema): void {
  if (!Array.isArray(out.type)) return
  const types = [
    ...new Set(out.type.filter((t): t is string => typeof t === "string")),
  ]
  const nonNull = types.filter((type) => type !== "null")
  if (nonNull.length < types.length && nonNull.length) out.nullable = true
  if (nonNull.length === 1) out.type = nonNull[0]
  else if (!nonNull.length) {
    if (types.length) out.type = "null"
    else delete out.type
  } else {
    delete out.type
    const branches = nonNull.map((type) => ({
      type,
      ...(type === "array" ? { items: {} } : {}),
    }))
    out.anyOf =
      Array.isArray(out.anyOf) ? [...out.anyOf, ...branches] : branches
  }
}

function normalizeTypedAnyOf(out: Schema): Schema {
  if (out.type === undefined || !Array.isArray(out.anyOf)) return out
  const branches = out.anyOf.filter((b) => !isObject(b) || b.type !== "null")
  if (branches.length < out.anyOf.length) out.nullable = true
  delete out.anyOf
  const only =
    branches.length === 1 && isObject(branches[0]) ? branches[0] : undefined
  if (only && (only.type === undefined || only.type === out.type))
    return { ...only, ...out }
  if (branches.length) {
    if (!Array.isArray(out.oneOf)) out.oneOf = branches
    else
      out.allOf = [
        ...(Array.isArray(out.allOf) ? out.allOf : []),
        { oneOf: branches },
      ]
  }
  return out
}

function normalizeEnum(out: Schema): void {
  if (out.type !== undefined || !Array.isArray(out.enum)) return
  const values = out.enum.filter((value) => value !== null)
  if (values.length < out.enum.length) out.nullable = true
  const kinds = new Set(
    values.map((v) => (Number.isInteger(v) ? "integer" : typeof v)),
  )
  const kind =
    kinds.size === 1 ? [...kinds][0]
    : kinds.size === 2 && kinds.has("integer") && kinds.has("number") ? "number"
    : ""
  if (["string", "integer", "number", "boolean"].includes(kind)) {
    out.type = kind
    out.enum = values
  } else delete out.enum
}

function geminiSchema(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 32) return schema
  let out = { ...schema }
  const sub = (value: unknown) => geminiSchema(value, depth + 1)
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ])
    if (isObject(out[key]))
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([name, value]) => [name, sub(value)]),
      )
  for (const key of [...unions, "prefixItems"])
    if (Array.isArray(out[key])) out[key] = out[key].map(sub)
  for (const key of [
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
  ])
    if (isObject(out[key])) out[key] = sub(out[key])
  normalizeTypeList(out)
  if (depth > 0) out = normalizeTypedAnyOf(out)
  normalizeEnum(out)
  if (out.type === undefined && isObject(out.properties)) out.type = "object"
  if (
    out.type === "array"
    || (out.type === undefined && Object.hasOwn(out, "items"))
  ) {
    if (Array.isArray(out.items))
      out.items =
        out.items.length === 1 && isObject(out.items[0]) ?
          sub(out.items[0])
        : {}
    else out.items = isObject(out.items) ? sub(out.items) : {}
    out.type = "array"
  }
  return out
}

/** Devin requires object roots, but only Gemini needs recursive wire repairs.
 * Do not use the general Gemini cleaner: it drops refs, enums and constraints.
 * Root union folding necessarily loses cross-field correlations; differing
 * property schemas remain alternatives, not a first-branch approximation.
 */
export function normalizeWindsurfToolSchema(
  schema: unknown,
  requestModel: string,
): Record<string, unknown> {
  const root = isObject(schema) ? schema : {}
  const folded = foldRoot(root, root)
  return /gemini/i.test(requestModel) ?
      (geminiSchema(folded) as Schema)
    : folded
}
