/**
 * gemini-schema 共享类型与工具函数。
 *
 * 用 Record<string, unknown> 而非窄类型，确保运行时检查不被 TS 视为冗余。
 */

export interface CleanOptions {
  addPlaceholder: boolean
  addMissingArrayItems: boolean
  antigravitySemantics: boolean
  removeToolTitle: boolean
  removeGeminiMetadata: boolean
  flattenUnions: boolean
  forceEnumStringType: boolean
  dropAllEnums: boolean
  dropBooleanEnums: boolean
  preserveAdditionalPropertiesFalse: boolean
}

export type Obj = Record<string, unknown>
export type Arr = Array<unknown>

export const PLACEHOLDER_REASON_DESCRIPTION =
  "Brief explanation of why you are calling this tool"

export const SCHEMA_NAME_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
])

// ============================================================
// 工具函数
// ============================================================

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function isArr(v: unknown): v is Arr {
  return Array.isArray(v)
}

export function omitKeys(node: Obj, keys: Set<string>): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) {
    if (!keys.has(k)) out[k] = v
  }
  return out
}

export function omitKey(node: Obj, key: string): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) {
    if (k !== key) out[k] = v
  }
  return out
}

export function mergeHint(existing: string, hint: string): string {
  if (!existing) return hint
  if (
    existing === hint
    || existing.startsWith(`${hint} (`)
    || existing.includes(`(${hint})`)
  ) {
    return existing
  }
  return `${existing} (${hint})`
}

export function appendHint(node: Obj, hint: string): Obj {
  const desc = typeof node.description === "string" ? node.description : ""
  return { ...node, description: mergeHint(desc, hint) }
}

export function valToStr(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || v === null)
    return String(v)
  return JSON.stringify(v)
}

export function refName(ref: string): string {
  const idx = ref.lastIndexOf("/")
  if (idx !== -1 && idx + 1 < ref.length) {
    return ref
      .slice(idx + 1)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~")
  }
  return ref
}

export function extractStringArray(val: unknown): Array<string> {
  if (!isArr(val)) return []
  return val.filter((v): v is string => typeof v === "string")
}

export function mergeStringSlices(
  a: Array<string>,
  b: Array<string>,
): Array<string> {
  const seen = new Set<string>()
  const res: Array<string> = []
  for (const s of [...a, ...b]) {
    if (s && !seen.has(s)) {
      seen.add(s)
      res.push(s)
    }
  }
  return res
}

// ============================================================
// 遍历工具
// ============================================================

/**
 * 前序遍历。inNameMap=true 表示父级是 name-map（properties 等），
 * 当前节点的键是作者定义的名称，不应被当作 schema 关键字。
 */
export function preOrder(
  node: unknown,
  inNameMap: boolean,
  fn: (node: Obj, inNameMap: boolean) => Obj,
): unknown {
  if (isArr(node)) {
    return node.map((item) => preOrder(item, false, fn))
  }
  if (!isObj(node)) return node

  const transformed = fn(node, inNameMap)
  const result: Obj = {}
  for (const [key, value] of Object.entries(transformed)) {
    result[key] = preOrder(value, SCHEMA_NAME_MAP_KEYWORDS.has(key), fn)
  }
  return result
}

/** 后序遍历：先递归子节点，再处理当前节点。 */
export function postOrder(
  node: unknown,
  inNameMap: boolean,
  fn: (node: Obj, inNameMap: boolean) => Obj,
): unknown {
  if (isArr(node)) {
    return node.map((item) => postOrder(item, false, fn))
  }
  if (!isObj(node)) return node

  const processed: Obj = {}
  for (const [key, value] of Object.entries(node)) {
    processed[key] = postOrder(value, SCHEMA_NAME_MAP_KEYWORDS.has(key), fn)
  }
  return fn(processed, inNameMap)
}

// ============================================================
// 类型判定辅助
// ============================================================

export function isAPIRequestDocument(m: Obj): boolean {
  if (isArr(m.tools) || isArr(m.contents) || isArr(m.messages)) return true
  if (isArr(m.functionDeclarations) || isArr(m.function_declarations))
    return true
  if (isObj(m.request)) return isAPIRequestDocument(m.request)
  return false
}

export function isKnownSchemaKeywordOrExtension(key: string): boolean {
  if (key.startsWith("x-")) return true
  return (
    SCHEMA_NAME_MAP_KEYWORDS.has(key)
    || [
      "const",
      "default",
      "dependencies",
      "dependentRequired",
      "discriminator",
      "enumDescriptions",
      "enumTitles",
      "example",
      "examples",
      "externalDocs",
      "items",
      "not",
      "prefixItems",
      "xml",
    ].includes(key)
  )
}

export function isNonObjectDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t !== "" && t !== "object"
  if (isArr(t)) {
    if (t.includes("object")) return false
    return t.length > 0
  }
  return false
}

export function isArrayDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t === "array"
  if (isArr(t)) return t.includes("array")
  return false
}
