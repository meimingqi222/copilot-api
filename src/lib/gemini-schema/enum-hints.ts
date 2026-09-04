/**
 * Phase 1c-1g: enum/const 转换与提示、additionalProperties 提示。
 */

import {
  type Obj,
  type CleanOptions,
  isArr,
  valToStr,
  appendHint,
  omitKey,
  preOrder,
} from "~/lib/gemini-schema/shared"

export function convertConstToEnum(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.const === undefined) return node
    if (node.enum === undefined) return { ...node, enum: [node.const] }
    return node
  })
}

export function convertEnumValuesToStrings(
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

export function addEnumHints(root: unknown): unknown {
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

export function dropIgnoredEnumsToHints(
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

export function addAdditionalPropertiesHints(root: unknown): unknown {
  return preOrder(root, false, (node, inNameMap) => {
    if (inNameMap) return node
    if (node.additionalProperties === false) {
      return appendHint(node, "No extra properties allowed")
    }
    return node
  })
}
