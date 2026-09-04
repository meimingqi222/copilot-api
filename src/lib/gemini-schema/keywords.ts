/**
 * Phase 3-4: 删除不支持关键字、删除占位符字段、清理 required、添加空 schema 占位符。
 */

import { constraintKeywords } from "~/lib/gemini-schema/constraints"
import {
  type Obj,
  type CleanOptions,
  isObj,
  isArr,
  omitKeys,
  omitKey,
  preOrder,
  postOrder,
  PLACEHOLDER_REASON_DESCRIPTION,
} from "~/lib/gemini-schema/shared"

export const UNSUPPORTED_KEYWORDS_BASE = [
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
// Phase 3a: 删除不支持的关键字
// ============================================================

export function removeUnsupportedKeywords(
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

export function removeKeywords(
  root: unknown,
  keywords: Array<string>,
): unknown {
  const keySet = new Set(keywords)
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    return omitKeys(node, keySet)
  })
}

// ============================================================
// Phase 3c: 删除占位符字段
// ============================================================

export function removePlaceholderFields(root: unknown): unknown {
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

export function cleanupRequiredFields(root: unknown): unknown {
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

export function addEmptySchemaPlaceholder(root: unknown): unknown {
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
