/* eslint-disable max-lines */
/**
 * gemini-schema 内部实现。移植自 CPA 的 internal/util/gemini_schema.go。
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

type Obj = Record<string, unknown>
type Arr = Array<unknown>

const PLACEHOLDER_REASON_DESCRIPTION =
  "Brief explanation of why you are calling this tool"

const SCHEMA_NAME_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
])

const UNSUPPORTED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "format",
  "default",
  "examples",
]

const UNSUPPORTED_KEYWORDS_BASE = [
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "$id",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "if",
  "then",
  "else",
  "$comment",
  "enumDescriptions",
  "enumTitles",
  "prefill",
  "deprecated",
  "encrypted",
]

// ============================================================
// 公开入口
// ============================================================

export function cleanJsonSchemaInternal(
  input: unknown,
  options: CleanOptions,
): unknown {
  let root = input

  root = normalizeMalformedSchemaObjects(root, options.addMissingArrayItems)

  if (options.antigravitySemantics) {
    root = inlineLocalRefs(root)
  }
  root = convertRefsToHints(root, options.antigravitySemantics)
  root = convertConstToEnum(root)
  root = convertEnumValuesToStrings(root, options.forceEnumStringType)
  root = addEnumHints(root)
  root = dropIgnoredEnumsToHints(root, options)
  if (!options.preserveAdditionalPropertiesFalse) {
    root = addAdditionalPropertiesHints(root)
  }
  root = moveConstraintsToDescription(root, options)
  if (options.antigravitySemantics) {
    root = moveNotToDescription(root)
  }

  root = mergeConditionals(root)
  root = mergeAllOf(root)
  if (options.flattenUnions) {
    root = flattenAnyOfOneOf(root)
  }
  root = flattenTypeArrays(root, options.antigravitySemantics)

  root = removeUnsupportedKeywords(root, options)
  if (options.removeGeminiMetadata) {
    root = removeKeywords(root, ["nullable", "title"])
    root = removePlaceholderFields(root)
  } else if (options.removeToolTitle) {
    root = removeKeywords(root, ["title"])
  }
  root = cleanupRequiredFields(root)

  if (options.addPlaceholder) {
    root = addEmptySchemaPlaceholder(root)
  }

  return root
}

// ============================================================
// 工具函数
// ============================================================

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isArr(v: unknown): v is Arr {
  return Array.isArray(v)
}

function omitKeys(node: Obj, keys: Set<string>): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) {
    if (!keys.has(k)) out[k] = v
  }
  return out
}

function omitKey(node: Obj, key: string): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) {
    if (k !== key) out[k] = v
  }
  return out
}

function mergeHint(existing: string, hint: string): string {
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

function appendHint(node: Obj, hint: string): Obj {
  const desc = typeof node.description === "string" ? node.description : ""
  return { ...node, description: mergeHint(desc, hint) }
}

function valToStr(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || v === null)
    return String(v)
  return JSON.stringify(v)
}

function refName(ref: string): string {
  const idx = ref.lastIndexOf("/")
  if (idx !== -1 && idx + 1 < ref.length) {
    return ref
      .slice(idx + 1)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~")
  }
  return ref
}

function extractStringArray(val: unknown): Array<string> {
  if (!isArr(val)) return []
  return val.filter((v): v is string => typeof v === "string")
}

function mergeStringSlices(a: Array<string>, b: Array<string>): Array<string> {
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
function preOrder(
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
function postOrder(
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
// Phase 0: 修复畸形 schema
// ============================================================

function normalizeMalformedSchemaObjects(
  root: unknown,
  addMissingArrayItems: boolean,
): unknown {
  if (!isObj(root)) return root
  if (isAPIRequestDocument(root)) return root

  const keys = Object.keys(root)
  if (keys.length === 1 && keys[0] === "schema" && isObj(root.schema)) {
    const r = repairSchemaNode(root.schema, addMissingArrayItems)
    return r.modified ? { schema: r.node } : root
  }

  const r = repairSchemaNode(root, addMissingArrayItems)
  return r.modified ? r.node : root
}

function isAPIRequestDocument(m: Obj): boolean {
  if (isArr(m.tools) || isArr(m.contents) || isArr(m.messages)) return true
  if (isArr(m.functionDeclarations) || isArr(m.function_declarations))
    return true
  if (isObj(m.request)) return isAPIRequestDocument(m.request)
  return false
}

function isKnownSchemaKeywordOrExtension(key: string): boolean {
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

function isNonObjectDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t !== "" && t !== "object"
  if (isArr(t)) {
    if (t.includes("object")) return false
    return t.length > 0
  }
  return false
}

function isArrayDeclaredType(t: unknown): boolean {
  if (typeof t === "string") return t === "array"
  if (isArr(t)) return t.includes("array")
  return false
}

interface RepairResult {
  node: Obj
  modified: boolean
}

function repairSchemaNode(
  node: Obj,
  addMissingArrayItems: boolean,
): RepairResult {
  let modified = false
  let clone: Obj = { ...node }

  // 1. 收集裸属性定义
  if (!isNonObjectDeclaredType(clone.type)) {
    const bareProps: Obj = {}
    for (const [k, v] of Object.entries(clone)) {
      if (isObj(v) && !isKnownSchemaKeywordOrExtension(k)) {
        bareProps[k] = v
      }
    }
    const bareKeys = Object.keys(bareProps)
    if (bareKeys.length > 0) {
      const { repaired, promotedReqs } = repairPropertyMap(
        bareProps,
        addMissingArrayItems,
      )
      clone = omitKeys(clone, new Set(bareKeys))

      if (isObj(clone.properties)) {
        clone.properties = { ...clone.properties, ...repaired }
      } else {
        clone.properties = repaired
        if (clone.type === undefined) clone.type = "object"
      }
      if (promotedReqs.length > 0) {
        clone.required = mergeStringSlices(
          extractStringArray(clone.required),
          promotedReqs,
        )
      }
      modified = true
    }
  }

  // 2. 递归修复 properties
  if (isObj(clone.properties)) {
    const {
      repaired,
      promotedReqs,
      modified: pm,
    } = repairPropertyMap(clone.properties, addMissingArrayItems)
    if (pm) {
      clone.properties = repaired
      modified = true
    }
    if (promotedReqs.length > 0) {
      clone.required = mergeStringSlices(
        extractStringArray(clone.required),
        promotedReqs,
      )
      modified = true
    }
  }

  // 数组类型缺少 items
  if (
    addMissingArrayItems
    && isArrayDeclaredType(clone.type)
    && clone.items === undefined
  ) {
    clone.items = { type: "string" }
    modified = true
  }

  // 3. 递归进入其他容器
  if (isObj(clone.items)) {
    const r = repairSchemaNode(clone.items, addMissingArrayItems)
    if (r.modified) {
      clone.items = r.node
      modified = true
    }
  } else if (isArr(clone.items)) {
    const r = repairSchemaList(clone.items, addMissingArrayItems)
    if (r.modified) {
      clone.items = r.list
      modified = true
    }
  }

  if (isObj(clone.additionalProperties)) {
    const r = repairSchemaNode(clone.additionalProperties, addMissingArrayItems)
    if (r.modified) {
      clone.additionalProperties = r.node
      modified = true
    }
  }

  if (isObj(clone.patternProperties)) {
    const { repaired, modified: pm } = repairPropertyMap(
      clone.patternProperties,
      addMissingArrayItems,
    )
    if (pm) {
      clone.patternProperties = repaired
      modified = true
    }
  }

  for (const key of [
    "if",
    "then",
    "else",
    "not",
    "contains",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "additionalItems",
  ]) {
    if (isObj(clone[key])) {
      const r = repairSchemaNode(clone[key], addMissingArrayItems)
      if (r.modified) {
        clone[key] = r.node
        modified = true
      }
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (isArr(clone[key])) {
      const r = repairSchemaList(clone[key], addMissingArrayItems)
      if (r.modified) {
        clone[key] = r.list
        modified = true
      }
    }
  }

  for (const key of ["$defs", "definitions", "dependentSchemas"]) {
    if (isObj(clone[key])) {
      const defsVal = clone[key]
      const repairedDefs: Obj = {}
      let defsModified = false
      for (const [dk, dv] of Object.entries(defsVal)) {
        if (isObj(dv)) {
          const r = repairSchemaNode(dv, addMissingArrayItems)
          repairedDefs[dk] = r.node
          if (r.modified) {
            defsModified = true
            modified = true
          }
        } else {
          repairedDefs[dk] = dv
        }
      }
      if (defsModified) clone[key] = repairedDefs
    }
  }

  return { node: clone, modified }
}

function repairSchemaList(
  list: Arr,
  addMissingArrayItems: boolean,
): { list: Arr; modified: boolean } {
  let modified = false
  const out: Arr = []
  for (const item of list) {
    if (isObj(item)) {
      const r = repairSchemaNode(item, addMissingArrayItems)
      out.push(r.node)
      if (r.modified) modified = true
    } else {
      out.push(item)
    }
  }
  return { list: out, modified }
}

function repairPropertyMap(
  props: Obj,
  addMissingArrayItems: boolean,
): { repaired: Obj; promotedReqs: Array<string>; modified: boolean } {
  const out: Obj = {}
  const promotedReqs: Array<string> = []
  let modified = false

  for (const [k, v] of Object.entries(props)) {
    if (!isObj(v)) {
      out[k] = v
      continue
    }

    const child: Obj = { ...v }
    if (typeof child.required === "boolean") {
      const wasReq = child.required
      delete child.required
      modified = true
      if (wasReq) promotedReqs.push(k)
    }

    const r = repairSchemaNode(child, addMissingArrayItems)
    if (r.modified) modified = true
    out[k] = r.node
  }

  promotedReqs.sort()
  return { repaired: out, promotedReqs, modified }
}

// ============================================================
// Phase 1a: 内联本地 $ref
// ============================================================

function inlineLocalRefs(root: unknown): unknown {
  if (!isObj(root) && !isArr(root)) return root
  if (!JSON.stringify(root).includes('"$ref"')) return root
  return resolveLocalRefs(root, root, new Set<string>())
}

function resolveLocalRefs(
  root: unknown,
  value: unknown,
  active: Set<string>,
): unknown {
  if (isArr(value)) {
    return value.map((item) => resolveLocalRefs(root, item, active))
  }
  if (!isObj(value)) return value

  const ref = value.$ref
  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = resolveJSONPointer(root, ref)
    if (target !== undefined) {
      if (active.has(ref)) {
        return cyclicRefFallback(value, target, ref)
      }
      active.add(ref)
      const resolvedTarget = resolveLocalRefs(root, target, active)
      active.delete(ref)
      if (isObj(resolvedTarget)) {
        return mergeResolvedRef(resolvedTarget, value, root, active)
      }
    }
  }

  const out: Obj = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = resolveLocalRefs(root, item, active)
  }
  return out
}

function mergeResolvedRef(
  resolvedTarget: Obj,
  value: Obj,
  root: unknown,
  active: Set<string>,
): Obj {
  const out: Obj = { ...resolvedTarget }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$ref") out[key] = resolveLocalRefs(root, item, active)
  }
  return out
}

function resolveJSONPointer(root: unknown, ref: string): unknown {
  let current: unknown = root
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~")
    if (isObj(current)) {
      current = current[part]
      if (current === undefined) return undefined
    } else if (isArr(current)) {
      const index = Number.parseInt(part, 10)
      if (Number.isNaN(index) || index < 0 || index >= current.length)
        return undefined
      current = current[index]
    } else {
      return undefined
    }
  }
  return current
}

function cyclicRefFallback(node: Obj, target: unknown, ref: string): Obj {
  const out: Obj = {}
  if (isObj(target)) {
    for (const key of ["type", "nullable", "description"]) {
      if (target[key] !== undefined) out[key] = target[key]
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref") out[key] = value
  }
  const hint = `See: ${refName(ref)}`
  out.description = mergeHint(
    typeof out.description === "string" ? out.description : "",
    hint,
  )
  return out
}

// ============================================================
// Phase 1b-1i: 转换和提示
// ============================================================

function convertRefsToHints(root: unknown, preserveSiblings: boolean): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (typeof node.$ref !== "string") return node
    const hint = `See: ${refName(node.$ref)}`
    if (!preserveSiblings) {
      const desc = typeof node.description === "string" ? node.description : ""
      return { type: "object", description: desc ? `${desc} (${hint})` : hint }
    }
    return appendHint(omitKey(node, "$ref"), hint)
  })
}

function convertConstToEnum(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.const === undefined) return node
    if (node.enum === undefined) return { ...node, enum: [node.const] }
    return node
  })
}

function convertEnumValuesToStrings(
  root: unknown,
  forceStringType: boolean,
): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (!isArr(node.enum)) return node
    const stringVals = node.enum.map((v) =>
      typeof v === "string" ? v : valToStr(v),
    )
    const result: Obj = { ...node, enum: stringVals }
    if (forceStringType) result.type = "string"
    return result
  })
}

function addEnumHints(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (!isArr(node.enum)) return node
    if (node.enum.length <= 1 || node.enum.length > 10) return node
    return appendHint(
      node,
      `Allowed: ${node.enum.map((v) => valToStr(v)).join(", ")}`,
    )
  })
}

function dropIgnoredEnumsToHints(
  root: unknown,
  options: CleanOptions,
): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (!isArr(node.enum)) return node
    const shouldDrop =
      options.dropAllEnums
      || (options.dropBooleanEnums && node.type === "boolean")
    if (!shouldDrop) return node
    if (node.enum.length === 1) {
      return omitKey(
        appendHint(node, `Allowed: ${valToStr(node.enum[0])}`),
        "enum",
      )
    }
    return omitKey(node, "enum")
  })
}

function addAdditionalPropertiesHints(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.additionalProperties === false) {
      return appendHint(node, "No extra properties allowed")
    }
    return node
  })
}

function constraintKeywords(options: CleanOptions): Array<string> {
  const keywords = [...UNSUPPORTED_CONSTRAINTS]
  if (options.antigravitySemantics) {
    keywords.push("minimum", "maximum", "multipleOf")
  }
  return keywords
}

function moveConstraintsToDescription(
  root: unknown,
  options: CleanOptions,
): unknown {
  const constraints = new Set(constraintKeywords(options))
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    let result = node
    for (const key of constraints) {
      if (result[key] !== undefined) {
        result = appendHint(result, `${key}: ${valToStr(result[key])}`)
      }
    }
    return omitKeys(result, constraints)
  })
}

function moveNotToDescription(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.not === undefined) return node
    const hinted = appendHint(node, `not: ${valToStr(node.not)}`)
    return omitKey(hinted, "not")
  })
}

// ============================================================
// Phase 2a: 合并条件
// ============================================================

function mergeConditionals(root: unknown): unknown {
  return postOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    let result = node

    for (const branchKey of ["then", "else"]) {
      const branch = result[branchKey]
      if (!isObj(branch)) continue
      const branchProps = branch.properties
      if (!isObj(branchProps)) continue

      const existingProps = result.properties
      if (isObj(existingProps)) {
        const merged: Obj = { ...existingProps }
        for (const [pk, pv] of Object.entries(branchProps)) {
          if (merged[pk] === undefined) merged[pk] = pv
        }
        result = { ...result, properties: merged }
      }
    }
    return result
  })
}

// ============================================================
// Phase 2b: 合并 allOf
// ============================================================

function mergeAllOf(root: unknown): unknown {
  return postOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (!isArr(node.allOf)) return node

    let result: Obj = { ...node }
    for (const item of node.allOf) {
      if (!isObj(item)) continue
      for (const [field, value] of Object.entries(item)) {
        if (field === "required") {
          if (!isArr(value)) continue
          result.required = mergeStringSlices(
            extractStringArray(result.required),
            value.filter((v): v is string => typeof v === "string"),
          )
        } else if (["allOf", "else", "if", "then"].includes(field)) {
          // 条件适用性无法表示，跳过
        } else {
          result = mergeMissingSchemaAtPath(result, field, value)
        }
      }
    }
    return omitKey(result, "allOf")
  })
}

function mergeMissingSchemaAtPath(
  target: Obj,
  field: string,
  incoming: unknown,
): Obj {
  const existing = target[field]
  if (existing === undefined) {
    return { ...target, [field]: incoming }
  }
  if (!isObj(existing) || !isObj(incoming)) return target

  let result = existing
  for (const [key, value] of Object.entries(incoming)) {
    result = mergeMissingSchemaAtPath(result, key, value)
  }
  return { ...target, [field]: result }
}

// ============================================================
// Phase 2c: 扁平化 anyOf/oneOf
// ============================================================

function mergeBranchProps(
  parentProps: Obj,
  items: Arr,
): { props: Obj; hasNull: boolean } {
  let props = parentProps
  let hasNull = false
  for (const item of items) {
    if (!isObj(item)) continue
    if (item.type === "null") hasNull = true
    const branchProps = item.properties
    if (!isObj(branchProps)) continue
    for (const [pk, pv] of Object.entries(branchProps)) {
      if (props[pk] === undefined) props = { ...props, [pk]: pv }
    }
  }
  return { props, hasNull }
}

function flattenAnyOfOneOf(root: unknown): unknown {
  return postOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node

    for (const key of ["anyOf", "oneOf"]) {
      if (!isArr(node[key])) continue
      const items = node[key]
      if (items.length === 0) continue

      const parentProps = node.properties
      if (isObj(parentProps)) {
        const merged = mergeBranchProps(parentProps, items)
        const result: Obj = { ...node, properties: merged.props }
        if (merged.hasNull) result.nullable = true
        return omitKey(result, key)
      }

      // 父级没有 properties：选择最强分支
      const { bestIdx, allTypes } = selectBest(items)
      const bestNode = isObj(items[bestIdx]) ? items[bestIdx] : {}
      const hasNull = items.some((item) => isObj(item) && item.type === "null")

      let result: Obj = { ...bestNode }
      if (hasNull && bestNode.type !== "null") {
        result.nullable = true
      }

      const parentDesc =
        typeof node.description === "string" ? node.description : ""
      if (parentDesc) {
        const childDesc =
          typeof result.description === "string" ? result.description : ""
        result.description =
          childDesc && childDesc !== parentDesc ?
            `${parentDesc} (${childDesc})`
          : parentDesc
      }

      if (allTypes.length > 1) {
        result = appendHint(result, `Accepts: ${allTypes.join(" | ")}`)
      }

      // 保留父级其他字段
      for (const [k, v] of Object.entries(node)) {
        if (k === key || k === "anyOf" || k === "oneOf") continue
        if (result[k] === undefined) result[k] = v
      }

      return result
    }

    return node
  })
}

function selectBest(items: Arr): { bestIdx: number; allTypes: Array<string> } {
  let bestIdx = 0
  let bestScore = -1
  const allTypes: Array<string> = []

  for (const [i, item_] of items.entries()) {
    const item = isObj(item_) ? item_ : {}
    const t = typeof item.type === "string" ? item.type : ""

    let typeStr = t
    let score: number
    if (t === "object" || item.properties !== undefined) {
      score = 3
      typeStr = t || "object"
    } else if (t === "array" || item.items !== undefined) {
      score = 2
      typeStr = t || "array"
    } else if (t !== "" && t !== "null") {
      score = 1
    } else if (t === "null") {
      score = 0
      typeStr = "null"
    } else {
      score = 0
    }

    if (typeStr) allTypes.push(typeStr)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }

  return { bestIdx, allTypes }
}

// ============================================================
// Phase 2d: 扁平化 type 数组
// ============================================================

function flattenTypeArrays(
  root: unknown,
  preserveNativeNullable: boolean,
): unknown {
  const result = postOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (!isArr(node.type)) return node

    let hasNull = false
    const nonNullTypes: Array<string> = []
    for (const item of node.type) {
      const s = typeof item === "string" ? item : valToStr(item)
      if (s === "null") hasNull = true
      else if (s !== "") nonNullTypes.push(s)
    }

    const firstType = nonNullTypes.length > 0 ? nonNullTypes[0] : "string"
    let result: Obj = { ...node, type: firstType }

    if (nonNullTypes.length > 1) {
      result = appendHint(result, `Accepts: ${nonNullTypes.join(" | ")}`)
    }

    if (hasNull) {
      if (preserveNativeNullable) {
        result.nullable = true
        result = appendHint(result, "(nullable)")
      } else {
        result = appendHint(result, "(nullable)")
        result._nullableMarked = true
      }
    }

    return result
  })

  return cleanupNullableMarks(result)
}

function cleanupNullableMarks(node: unknown): unknown {
  if (isArr(node)) {
    return node.map((item) => cleanupNullableMarks(item))
  }
  if (!isObj(node)) return node

  // 处理 properties 中的 nullable 字段
  if (isObj(node.properties)) {
    const props = node.properties
    const nullableFields: Array<string> = []
    const cleanedProps: Obj = {}

    for (const [key, val] of Object.entries(props)) {
      if (isObj(val) && val._nullableMarked === true) {
        nullableFields.push(key)
        cleanedProps[key] = omitKey(val, "_nullableMarked")
      } else {
        cleanedProps[key] = cleanupNullableMarks(val)
      }
    }

    if (nullableFields.length > 0 && isArr(node.required)) {
      const filtered = node.required.filter(
        (r) => typeof r === "string" && !nullableFields.includes(r),
      )
      if (filtered.length === 0) {
        return omitKey({ ...node, properties: cleanedProps }, "required")
      }
      return { ...node, properties: cleanedProps, required: filtered }
    }

    return { ...node, properties: cleanedProps }
  }

  // 递归，跳过 _nullableMarked
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === "_nullableMarked") continue
    out[k] = cleanupNullableMarks(v)
  }
  return out
}

// ============================================================
// Phase 3a: 删除不支持的关键字
// ============================================================

function removeUnsupportedKeywords(
  root: unknown,
  options: CleanOptions,
): unknown {
  const keywords = new Set([
    ...constraintKeywords(options),
    ...UNSUPPORTED_KEYWORDS_BASE,
  ])
  if (options.antigravitySemantics) {
    keywords.add("not")
  }

  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node

    const toDelete = new Set<string>()
    for (const key of Object.keys(node)) {
      if (keywords.has(key)) {
        if (
          options.preserveAdditionalPropertiesFalse
          && key === "additionalProperties"
          && node[key] === false
        ) {
          continue
        }
        toDelete.add(key)
      }
      if (key.startsWith("x-")) {
        toDelete.add(key)
      }
    }
    return toDelete.size > 0 ? omitKeys(node, toDelete) : node
  })
}

function removeKeywords(root: unknown, keywords: Array<string>): unknown {
  const keySet = new Set(keywords)
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    return omitKeys(node, keySet)
  })
}

// ============================================================
// Phase 3c: 删除占位符字段
// ============================================================

function removePlaceholderFields(root: unknown): unknown {
  return preOrder(root, true, (node) => {
    if (!isObj(node.properties)) return node
    const props = node.properties
    let modified = false
    const newProps: Obj = {}
    const toRemoveFromRequired: Array<string> = []

    for (const [key, val] of Object.entries(props)) {
      if (key === "_") {
        modified = true
        toRemoveFromRequired.push("_")
        continue
      }
      if (
        key === "reason"
        && isObj(val)
        && val.description === PLACEHOLDER_REASON_DESCRIPTION
        && Object.keys(props).length === 1
      ) {
        modified = true
        toRemoveFromRequired.push("reason")
        continue
      }
      newProps[key] = val
    }

    if (!modified) return node

    let result: Obj = { ...node, properties: newProps }
    if (toRemoveFromRequired.length > 0 && isArr(result.required)) {
      const filtered = result.required.filter(
        (r) => typeof r === "string" && !toRemoveFromRequired.includes(r),
      )
      if (filtered.length === 0) {
        result = omitKey(result, "required")
      } else {
        result.required = filtered
      }
    }
    return result
  })
}

// ============================================================
// Phase 3d: 清理 required
// ============================================================

function cleanupRequiredFields(root: unknown): unknown {
  return preOrder(root, true, (node) => {
    if (!isArr(node.required)) return node
    if (!isObj(node.properties)) {
      return omitKey(node, "required")
    }
    const props = node.properties
    const valid = node.required.filter(
      (r) => typeof r === "string" && props[r] !== undefined,
    )
    if (valid.length === node.required.length) return node
    if (valid.length === 0) return omitKey(node, "required")
    return { ...node, required: valid }
  })
}

// ============================================================
// Phase 4: 添加空 schema 占位符
// ============================================================

function addEmptySchemaPlaceholder(root: unknown): unknown {
  return postOrder(root, true, (node, inNameMap) => {
    if (node.type !== "object") return node

    const props = node.properties
    const req = node.required
    const hasRequired = isArr(req) && req.length > 0

    const noProps = props === undefined
    const emptyProps = isObj(props) && Object.keys(props).length === 0
    const needsPlaceholder = noProps || emptyProps

    if (needsPlaceholder) {
      return {
        ...node,
        properties: {
          reason: {
            type: "string",
            description: PLACEHOLDER_REASON_DESCRIPTION,
          },
        },
        required: ["reason"],
      }
    }

    if (isObj(props) && !hasRequired && inNameMap && props._ === undefined) {
      return {
        ...node,
        properties: { ...props, _: { type: "boolean" } },
        required: ["_"],
      }
    }

    return node
  })
}
