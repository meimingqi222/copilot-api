/**
 * Phase 1h/1i: 将不支持的约束关键字与 not 移入 description hint。
 */

import {
  type CleanOptions,
  valToStr,
  appendHint,
  omitKeys,
  omitKey,
  preOrder,
} from "~/lib/gemini-schema/shared"

export const UNSUPPORTED_CONSTRAINTS = [
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

export function constraintKeywords(options: CleanOptions): Array<string> {
  const keywords = [...UNSUPPORTED_CONSTRAINTS]
  if (options.antigravitySemantics) {
    keywords.push("minimum", "maximum", "multipleOf")
  }
  return keywords
}

export function moveConstraintsToDescription(
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

export function moveNotToDescription(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.not === undefined) return node
    const hinted = appendHint(node, `not: ${valToStr(node.not)}`)
    return omitKey(hinted, "not")
  })
}
