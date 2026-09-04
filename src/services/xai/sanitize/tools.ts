/**
 * xAI 工具相关规范化：工具列表/tool_choice/input 自定义工具调用等。
 * 从 `sanitize-body.ts` 拆分而来，纯代码移动，无行为变更。
 */

import {
  NAMESPACE_TOOL_TYPE,
  normalizeXaiNamespaceToolChoice,
  qualifyXaiNamespaceToolName,
} from "./namespace-tools"
import {
  hasNonObjectRootUnion,
  injectObjectRootUnionBranchTypes,
} from "./schema"

const DROP_TOOL_TYPES = new Set(["tool_search", "image_generation"])
const CUSTOM_TOOL_TYPE = "custom"
const FUNCTION_TOOL_TYPE = "function"
const WEB_SEARCH_TOOL_TYPE = "web_search"
const ADDITIONAL_TOOLS_TYPE = "additional_tools"
export { ADDITIONAL_TOOLS_TYPE, FUNCTION_TOOL_TYPE }
const APPLY_PATCH_TOOL_NAME = "apply_patch"
const CODEX_APP_NAMESPACE = "codex_app"
const AUTOMATION_UPDATE_TOOL = "automation_update"
const SAFE_FUNCTION_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const
const EMPTY_FUNCTION_PARAMETERS = {
  type: "object",
  properties: {},
} as const

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Drop tool_choice / parallel_tool_calls when no tools remain.
 * Mirrors CPA `normalizeXAIToolChoiceForTools`.
 */
export function normalizeXaiToolChoiceForTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = body.tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (hasTools) {
    return body
  }
  // additional_tools may still live in input before promotion — already
  // handled by normalizeXaiToolsAndInput.
  const {
    tools: _t,
    tool_choice: _tc,
    parallel_tool_calls: _ptc,
    ...rest
  } = body
  return rest
}

export function normalizeXaiToolsAndInput(
  body: Record<string, unknown>,
): Record<string, unknown> {
  let next = { ...body }

  // Promote Responses Lite `additional_tools` input items to top-level tools.
  if (Array.isArray(next.input)) {
    const inputItems = next.input as Array<unknown>
    const { remainingInput, promoted } = splitAdditionalTools(inputItems)
    if (promoted.length > 0 || remainingInput.length !== inputItems.length) {
      const existingTools =
        Array.isArray(next.tools) ? (next.tools as Array<unknown>) : []
      next = {
        ...next,
        input: remainingInput,
        tools: [...existingTools, ...promoted],
      }
    }
  }

  if (Array.isArray(next.tools)) {
    next = {
      ...next,
      tools: normalizeXaiToolList(next.tools as Array<unknown>),
    }
  }

  next = normalizeXaiNamespaceToolChoice(next)
  next = normalizeXaiForcedWebSearchToolChoice(next)
  next = pruneXaiOrphanedToolChoice(next)
  return next
}

/** Convert Codex custom-tool history into xAI's function-call input shape. */
export function normalizeXaiInputCustomToolCalls(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body

  let changed = false
  const input: Array<unknown> = []
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      input.push(item)
      continue
    }
    const record = item as Record<string, unknown>
    if (record.type === "custom_tool_call") {
      const callId = stringValue(record.call_id)
      const name = stringValue(record.name)
      changed = true
      if (!callId || !name) continue
      input.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: customToolCallArguments(record.input),
      })
      continue
    }
    if (record.type === "custom_tool_call_output") {
      const callId = stringValue(record.call_id)
      changed = true
      if (!callId) continue
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: customToolCallOutput(record.output),
      })
      continue
    }
    input.push(item)
  }
  return changed ? { ...body, input } : body
}

function customToolCallArguments(input: unknown): string {
  if (input === undefined) return "{}"
  if (typeof input === "string") {
    const trimmed = input.trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return JSON.stringify(parsed)
        }
      } catch {
        // Preserve non-JSON custom input under the generic input property.
      }
    }
    return JSON.stringify({ input })
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return JSON.stringify(input)
  }
  return JSON.stringify({ input })
}

function customToolCallOutput(output: unknown): string {
  if (output === undefined) return ""
  return typeof output === "string" ? output : JSON.stringify(output)
}

function isAdditionalToolsItem(
  item: unknown,
): item is { type: string; tools?: unknown } {
  return (
    Boolean(item)
    && typeof item === "object"
    && !Array.isArray(item)
    && (item as { type?: unknown }).type === ADDITIONAL_TOOLS_TYPE
  )
}

function splitAdditionalTools(inputItems: Array<unknown>): {
  remainingInput: Array<unknown>
  promoted: Array<unknown>
} {
  const remainingInput: Array<unknown> = []
  const promoted: Array<unknown> = []
  for (const item of inputItems) {
    if (!isAdditionalToolsItem(item)) {
      remainingInput.push(item)
      continue
    }
    const nested = item.tools
    if (!Array.isArray(nested)) continue
    for (const tool of nested) {
      promoted.push(tool)
    }
  }
  return { remainingInput, promoted }
}

function normalizeXaiToolList(tools: Array<unknown>): Array<unknown> {
  const out: Array<unknown> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool)
      continue
    }
    const record = tool as Record<string, unknown>
    const toolType = typeof record.type === "string" ? record.type : ""

    if (toolType === NAMESPACE_TOOL_TYPE) {
      const namespaceName =
        typeof record.name === "string" ? record.name.trim() : ""
      const nested = Array.isArray(record.tools) ? record.tools : []
      for (const nestedTool of nested) {
        const normalized = normalizeXaiTool(nestedTool, namespaceName)
        if (normalized) out.push(normalized)
      }
      continue
    }

    const normalized = normalizeXaiTool(tool, "")
    if (normalized) out.push(normalized)
  }
  return out
}

function normalizeXaiTool(
  tool: unknown,
  namespaceName: string,
): Record<string, unknown> | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return null
  }

  let next: Record<string, unknown> = { ...(tool as Record<string, unknown>) }
  let toolType = typeof next.type === "string" ? next.type : ""

  if (DROP_TOOL_TYPES.has(toolType)) {
    return null
  }

  const toolName = typeof next.name === "string" ? next.name : ""
  if (toolType === CUSTOM_TOOL_TYPE && toolName === APPLY_PATCH_TOOL_NAME) {
    return null
  }

  if (toolType === CUSTOM_TOOL_TYPE) {
    next = { ...next, type: FUNCTION_TOOL_TYPE }
    toolType = FUNCTION_TOOL_TYPE
  }

  if (toolType === WEB_SEARCH_TOOL_TYPE && "external_web_access" in next) {
    const { external_web_access: _e, ...rest } = next
    next = rest
  }

  if (toolType === FUNCTION_TOOL_TYPE) {
    if (
      !("parameters" in next)
      || next.parameters === null
      || next.parameters === undefined
    ) {
      next = { ...next, parameters: { ...EMPTY_FUNCTION_PARAMETERS } }
    } else {
      // Untyped root union branches become explicit object-only branches
      // before the simplification check (CPA normalizeXAIObjectRootUnionBranchTypes).
      const injected = injectObjectRootUnionBranchTypes(next)
      if (injected) next = injected
    }

    // Codex Desktop automation_update + non-object root unions hang or 400.
    if (xaiFunctionParametersNeedSimplification(next, namespaceName)) {
      next = {
        ...next,
        parameters: { ...SAFE_FUNCTION_PARAMETERS },
        ...(next.strict === true ? { strict: false } : {}),
      }
    }

    if (namespaceName) {
      const shortName = typeof next.name === "string" ? next.name.trim() : ""
      const qualified = qualifyXaiNamespaceToolName(namespaceName, shortName)
      if (!qualified) return null
      next = { ...next, name: qualified }
    }
  }

  return next
}

function xaiFunctionParametersNeedSimplification(
  tool: Record<string, unknown>,
  namespaceName: string,
): boolean {
  const name = typeof tool.name === "string" ? tool.name : ""
  if (
    name === `${CODEX_APP_NAMESPACE}__${AUTOMATION_UPDATE_TOOL}`
    || (namespaceName === CODEX_APP_NAMESPACE
      && name === AUTOMATION_UPDATE_TOOL)
  ) {
    return true
  }
  // Short-circuit: only scan when parameters is a non-trivial object.
  const parameters = tool.parameters
  if (
    !parameters
    || typeof parameters !== "object"
    || Array.isArray(parameters)
  ) {
    return false
  }
  return hasNonObjectRootUnion(parameters as Record<string, unknown>)
}

/**
 * Rewrite forced `tool_choice: { type: "web_search" }` into allowed_tools form
 * accepted by xAI's ModelToolChoice schema.
 */
function normalizeXaiForcedWebSearchToolChoice(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const choice = body.tool_choice
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return body
  }
  const record = choice as Record<string, unknown>
  if (record.type !== WEB_SEARCH_TOOL_TYPE) {
    return body
  }
  return {
    ...body,
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [record],
    },
  }
}

type ToolChoiceKey = { toolType: string; name: string }

function pruneXaiOrphanedToolChoice(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!("tool_choice" in body)) return body
  const choice = body.tool_choice
  if (choice === null || choice === undefined) return body
  if (typeof choice === "string") return body // auto / none / required
  if (typeof choice !== "object" || Array.isArray(choice)) return body

  const available = collectAvailableToolChoiceKeys(body)
  const record = choice as Record<string, unknown>
  const choiceType = typeof record.type === "string" ? record.type.trim() : ""

  if (choiceType === "allowed_tools") {
    const allowed = Array.isArray(record.tools) ? record.tools : []
    const filtered = allowed.filter((tool) =>
      toolChoiceMatchesAvailable(tool, available),
    )
    if (filtered.length === allowed.length) return body
    if (filtered.length === 0) {
      const { tool_choice: _tc, ...rest } = body
      return rest
    }
    return {
      ...body,
      tool_choice: { ...record, tools: filtered },
    }
  }

  if (!choiceType) return body
  if (toolChoiceMatchesAvailable(choice, available)) return body
  const { tool_choice: _tc, ...rest } = body
  return rest
}

function collectAvailableToolChoiceKeys(
  body: Record<string, unknown>,
): Set<string> {
  const keys = new Set<string>()
  const addTools = (tools: unknown) => {
    if (!Array.isArray(tools)) return
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
      const record = tool as Record<string, unknown>
      const toolType = typeof record.type === "string" ? record.type.trim() : ""
      if (!toolType) continue
      if (toolType === FUNCTION_TOOL_TYPE || toolType === CUSTOM_TOOL_TYPE) {
        const name = typeof record.name === "string" ? record.name.trim() : ""
        if (!name) continue
        keys.add(toolChoiceKey({ toolType, name }))
      } else {
        keys.add(toolChoiceKey({ toolType, name: "" }))
      }
    }
  }

  addTools(body.tools)
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && (item as { type?: unknown }).type === ADDITIONAL_TOOLS_TYPE
      ) {
        addTools((item as { tools?: unknown }).tools)
      }
    }
  }
  return keys
}

function toolChoiceKey(key: ToolChoiceKey): string {
  return key.name ? `${key.toolType}\0${key.name}` : key.toolType
}

function toolChoiceMatchesAvailable(
  choice: unknown,
  available: Set<string>,
): boolean {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return false
  }
  const record = choice as Record<string, unknown>
  const toolType = typeof record.type === "string" ? record.type.trim() : ""
  if (!toolType) return false
  if (toolType === FUNCTION_TOOL_TYPE || toolType === CUSTOM_TOOL_TYPE) {
    const name = typeof record.name === "string" ? record.name.trim() : ""
    if (!name) return false
    return available.has(toolChoiceKey({ toolType, name }))
  }
  return available.has(toolChoiceKey({ toolType, name: "" }))
}
