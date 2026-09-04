/**
 * Phase 2a-2d: 合并条件、合并 allOf、扁平化 anyOf/oneOf、扁平化 type 数组。
 */

import {
  type Obj,
  type Arr,
  isObj,
  isArr,
  omitKey,
  appendHint,
  valToStr,
  postOrder,
  extractStringArray,
  mergeStringSlices,
} from "~/lib/gemini-schema/shared"

// ============================================================
// Phase 2a: 合并条件
// ============================================================

export function mergeConditionals(root: unknown): unknown {
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

export function mergeAllOf(root: unknown): unknown {
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

export function flattenAnyOfOneOf(root: unknown): unknown {
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

export function flattenTypeArrays(
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
