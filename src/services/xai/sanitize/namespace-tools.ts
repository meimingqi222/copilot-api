/**
 * xAI namespace 工具相关处理：收集/还原命名空间工具引用、
 * 规范化命名空间 tool_choice 与 input 中的命名空间调用。
 * 从 `sanitize-body.ts` 拆分而来，纯代码移动，无行为变更。
 */

import { ADDITIONAL_TOOLS_TYPE, FUNCTION_TOOL_TYPE, stringValue } from "./tools"

export type XaiNamespaceToolRef = {
  namespace: string
  name: string
}

const NAMESPACE_TOOL_TYPE = "namespace"
export { NAMESPACE_TOOL_TYPE }

export function qualifyXaiNamespaceToolName(
  namespaceName: string,
  toolName: string,
): string {
  const ns = namespaceName.trim()
  const name = toolName.trim()
  if (!ns || !name || name.startsWith("mcp__")) return name
  const prefix = ns.endsWith("__") ? ns : `${ns}__`
  if (name.startsWith(prefix)) return name
  return `${prefix}${name}`
}

/**
 * Records every namespace-declared tool as qualifiedName → { namespace, name }
 * so the response path can restore function_call names to the client's
 * namespace shape. Mirrors CPA `collectXAINamespaceToolRefs`.
 */
export function collectXaiNamespaceToolRefs(
  body: Record<string, unknown>,
): Map<string, XaiNamespaceToolRef> {
  const refs = new Map<string, XaiNamespaceToolRef>()
  const collect = (tools: unknown): void => {
    if (!Array.isArray(tools)) return
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
      const record = tool as Record<string, unknown>
      if (record.type !== NAMESPACE_TOOL_TYPE) continue
      const namespaceName =
        typeof record.name === "string" ? record.name.trim() : ""
      if (!namespaceName) continue
      const nested = Array.isArray(record.tools) ? record.tools : []
      for (const nestedTool of nested) {
        if (
          !nestedTool
          || typeof nestedTool !== "object"
          || Array.isArray(nestedTool)
        ) {
          continue
        }
        const toolName =
          typeof (nestedTool as Record<string, unknown>).name === "string" ?
            ((nestedTool as Record<string, unknown>).name as string).trim()
          : ""
        const qualified = qualifyXaiNamespaceToolName(namespaceName, toolName)
        if (!qualified) continue
        refs.set(qualified, { namespace: namespaceName, name: toolName })
      }
    }
  }

  collect(body.tools)
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && (item as { type?: unknown }).type === ADDITIONAL_TOOLS_TYPE
      ) {
        collect((item as { tools?: unknown }).tools)
      }
    }
  }
  return refs
}

/**
 * Restore namespace-qualified function_call names in an upstream SSE/WS data
 * payload back to short name + namespace. Mirrors CPA
 * `restoreXAINamespaceToolCalls` (item path + response.output[*]).
 */
export function restoreXaiNamespaceToolCalls(
  data: string,
  refs: Map<string, XaiNamespaceToolRef>,
): string {
  if (refs.size === 0 || !data) return data
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data) as Record<string, unknown>
  } catch {
    return data
  }
  const restoreAt = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false
    const record = value as Record<string, unknown>
    if (record.type !== "function_call") return false
    const qualified = typeof record.name === "string" ? record.name.trim() : ""
    const ref = refs.get(qualified)
    if (!ref) return false
    record.name = ref.name
    record.namespace = ref.namespace
    return true
  }

  let changed = restoreAt(parsed.item)

  const output = parsed.response
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const outputArray = (output as Record<string, unknown>).output
    if (Array.isArray(outputArray)) {
      for (const item of outputArray) {
        if (restoreAt(item)) changed = true
      }
    }
  }

  if (changed) {
    return JSON.stringify(parsed)
  }
  return data
}

/**
 * Qualify namespaced function tool_choice the same way tools are flattened.
 */
export function normalizeXaiNamespaceToolChoice(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const choice = body.tool_choice
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return body
  }

  const qualifyChoice = (
    entry: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (entry.type !== FUNCTION_TOOL_TYPE) return entry
    const namespace =
      typeof entry.namespace === "string" ? entry.namespace.trim() : ""
    const name = typeof entry.name === "string" ? entry.name.trim() : ""
    if (!namespace || !name) return entry
    const qualified = qualifyXaiNamespaceToolName(namespace, name)
    if (!qualified) return entry
    const { namespace: _ns, ...rest } = entry
    return { ...rest, name: qualified }
  }

  const record = choice as Record<string, unknown>
  if (record.type === FUNCTION_TOOL_TYPE) {
    return { ...body, tool_choice: qualifyChoice(record) }
  }

  if (record.type === "allowed_tools" && Array.isArray(record.tools)) {
    const tools = record.tools as Array<unknown>
    return {
      ...body,
      tool_choice: {
        ...record,
        tools: tools.map((item): unknown => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item
          }
          return qualifyChoice(item as Record<string, unknown>)
        }),
      },
    }
  }

  return body
}

/** Flatten client-visible namespace calls back to the qualified xAI name. */
export function normalizeXaiInputNamespaceToolCalls(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body

  const input = body.input.map((item): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    if (record.type !== "function_call") return item
    const namespace = stringValue(record.namespace)
    const name = stringValue(record.name)
    if (!namespace || !name) return item
    const qualified = qualifyXaiNamespaceToolName(namespace, name)
    const { namespace: _namespace, ...rest } = record
    return { ...rest, name: qualified }
  })
  return { ...body, input }
}
