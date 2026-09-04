/**
 * Phase 0: 修复畸形 schema。
 */

import {
  type Obj,
  type Arr,
  isObj,
  isArr,
  omitKeys,
  extractStringArray,
  mergeStringSlices,
  isAPIRequestDocument,
  isKnownSchemaKeywordOrExtension,
  isNonObjectDeclaredType,
  isArrayDeclaredType,
} from "~/lib/gemini-schema/shared"

export function normalizeMalformedSchemaObjects(
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
