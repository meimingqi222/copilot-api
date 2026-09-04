/**
 * Phase 1a: 内联本地 $ref；Phase 1b: 将 $ref 转为 description hint。
 */

import {
  type Obj,
  isObj,
  isArr,
  omitKey,
  mergeHint,
  appendHint,
  refName,
  preOrder,
} from "~/lib/gemini-schema/shared"

// ============================================================
// Phase 1a: 内联本地 $ref
// ============================================================

export function inlineLocalRefs(root: unknown): unknown {
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
// Phase 1b: 将 $ref 转为 description hint
// ============================================================

export function convertRefsToHints(
  root: unknown,
  preserveSiblings: boolean,
): unknown {
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
