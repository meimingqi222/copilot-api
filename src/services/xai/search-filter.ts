/**
 * xAI Internal X Search Response Filter
 *
 * xAI executes x_search subtools (x_user_search, x_semantic_search,
 * x_keyword_search, x_thread_fetch) server-side but exposes their trace as
 * client-style custom_tool_call / function_call items with `xs_call` call_ids.
 *
 * This filter hides those internal traces from downstream Responses clients so
 * clients don't attempt to execute them or reply with dangling tool outputs.
 *
 * Mirrors CPA's `xaiInternalXSearchResponseFilter` (xai_executor_response.go).
 */

import type { ResponsesResponse } from "~/services/copilot/responses-api"

export interface XaiClientToolKey {
  namespace: string
  name: string
  toolType: string
}

const INTERNAL_X_SEARCH_TOOL_NAMES = new Set([
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
])

export function isInternalXSearchToolName(name: string): boolean {
  return INTERNAL_X_SEARCH_TOOL_NAMES.has(name.trim())
}

export function isInternalXSearchCallId(callId: string | undefined): boolean {
  if (!callId) return false
  return callId.trim().startsWith("xs_call")
}

/**
 * Maps a Responses output call item type to the effective upstream tool
 * declaration kind, or undefined when the item is not a callable tool.
 */
function xaiResponseCallDeclaredType(itemType: string): string | undefined {
  if (itemType === "function_call") return "function"
  if (itemType === "custom_tool_call") return "custom"
  return undefined
}

function toolKeyString(key: XaiClientToolKey): string {
  return `${key.namespace}:${key.name}:${key.toolType}`
}

/**
 * Checks if the request body explicitly uses native `x_search`.
 */
export function xaiRequestHasNativeXSearch(
  body: Record<string, unknown>,
): boolean {
  if (hasXSearchTool(body.tools)) return true

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && (item as { type?: unknown }).type === "additional_tools"
        && hasXSearchTool((item as { tools?: unknown }).tools)
      ) {
        return true
      }
    }
  }

  return false
}

/** Whether a raw `tools` array contains a native `x_search` tool declaration. */
function hasXSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false
  for (const tool of tools) {
    if (
      tool
      && typeof tool === "object"
      && !Array.isArray(tool)
      && (tool as { type?: unknown }).type === "x_search"
    ) {
      return true
    }
  }
  return false
}

/**
 * Collects client-declared callable tools before normalization.
 */
export function collectXaiClientDeclaredTools(
  body: Record<string, unknown>,
): Set<string> {
  const keys = new Set<string>()

  const collect = (tools: unknown): void => {
    if (!Array.isArray(tools)) return
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
      const record = tool as Record<string, unknown>
      const toolType = typeof record.type === "string" ? record.type.trim() : ""

      if (toolType === "namespace") {
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
          const nestedRecord = nestedTool as Record<string, unknown>
          const nestedType =
            typeof nestedRecord.type === "string" ?
              nestedRecord.type.trim()
            : ""
          if (nestedType !== "function" && nestedType !== "custom") continue
          const toolName =
            typeof nestedRecord.name === "string" ?
              nestedRecord.name.trim()
            : ""
          if (!toolName) continue
          keys.add(
            toolKeyString({
              namespace: namespaceName,
              name: toolName,
              toolType: nestedType === "custom" ? "function" : nestedType,
            }),
          )
        }
        continue
      }

      if (toolType === "function" || toolType === "custom") {
        const toolName =
          typeof record.name === "string" ? record.name.trim() : ""
        if (!toolName) continue
        keys.add(
          toolKeyString({
            namespace: "",
            name: toolName,
            toolType: toolType === "custom" ? "function" : toolType,
          }),
        )
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
        && (item as { type?: unknown }).type === "additional_tools"
      ) {
        collect((item as { tools?: unknown }).tools)
      }
    }
  }

  return keys
}

export class XaiInternalXSearchResponseFilter {
  private enabled: boolean
  private clientDeclaredTools: Set<string>
  private droppedOutputIndexes = new Set<number>()
  private droppedItemIDs = new Set<string>()

  constructor(enabled: boolean, clientDeclaredTools?: Set<string>) {
    this.enabled = enabled
    this.clientDeclaredTools = clientDeclaredTools ?? new Set()
  }

  public isInternalXSearchCall(item: Record<string, unknown>): boolean {
    const itemType = typeof item.type === "string" ? item.type.trim() : ""
    const declaredType = xaiResponseCallDeclaredType(itemType)
    if (!declaredType) return false

    const name = typeof item.name === "string" ? item.name.trim() : ""
    if (!isInternalXSearchToolName(name)) {
      return false
    }

    const namespace =
      typeof item.namespace === "string" ? item.namespace.trim() : ""
    // Namespaced calls are restored client tools, never xAI internal X Search traces
    if (namespace) {
      return false
    }

    // Evidenced internal call_id prefix always identifies server-side X Search traces
    const callId = typeof item.call_id === "string" ? item.call_id.trim() : ""
    if (isInternalXSearchCallId(callId)) {
      return true
    }

    // Preserve only client tools whose effective declaration matches this call type
    const key = toolKeyString({ namespace: "", name, toolType: declaredType })
    if (this.clientDeclaredTools.has(key)) {
      return false
    }

    return true
  }

  /**
   * Filter an SSE data frame. Returns the modified JSON string, or null if
   * this frame should be dropped entirely.
   */
  public apply(eventData: string): string | null {
    if (!this.enabled || !eventData) return eventData

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(eventData) as Record<string, unknown>
    } catch {
      return eventData
    }

    // Check item in output_item events
    const item = parsed.item
    if (
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && this.isInternalXSearchCall(item as Record<string, unknown>)
    ) {
      this.recordDroppedItem(parsed, item as Record<string, unknown>)
      return null
    }

    // Filter response.output in completed events
    this.filterCompletedOutput(parsed)

    if (this.referencesDroppedItem(parsed)) {
      return null
    }

    this.compactOutputIndex(parsed)
    return JSON.stringify(parsed)
  }

  /**
   * Filter output items in a collected non-stream response in-place.
   */
  public filterResponse(response: ResponsesResponse): void {
    if (!this.enabled || !Array.isArray(response.output)) return

    const remaining: Array<unknown> = []
    for (const item of response.output) {
      if (
        typeof item === "object"
        && !Array.isArray(item)
        && this.isInternalXSearchCall(
          item as unknown as Record<string, unknown>,
        )
      ) {
        continue
      }
      remaining.push(item)
    }
    response.output = remaining as typeof response.output
  }

  private recordDroppedItem(
    event: Record<string, unknown>,
    item: Record<string, unknown>,
  ): void {
    if (typeof event.output_index === "number") {
      this.droppedOutputIndexes.add(event.output_index)
    }
    for (const key of ["id", "call_id"]) {
      const val = item[key]
      if (typeof val === "string" && val.trim()) {
        this.droppedItemIDs.add(val.trim())
      }
    }
  }

  private referencesDroppedItem(event: Record<string, unknown>): boolean {
    if (
      typeof event.output_index === "number"
      && this.droppedOutputIndexes.has(event.output_index)
    ) {
      return true
    }
    for (const key of ["item_id", "call_id"]) {
      const val = event[key]
      if (typeof val === "string" && this.droppedItemIDs.has(val.trim())) {
        return true
      }
    }
    return false
  }

  private compactOutputIndex(event: Record<string, unknown>): void {
    if (typeof event.output_index !== "number") return
    const original = event.output_index
    let removedBefore = 0
    for (const dropped of this.droppedOutputIndexes) {
      if (dropped < original) {
        removedBefore++
      }
    }
    if (removedBefore > 0) {
      event.output_index = original - removedBefore
    }
  }

  private filterCompletedOutput(event: Record<string, unknown>): void {
    const response = event.response
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return
    }
    const output = (response as Record<string, unknown>).output
    if (!Array.isArray(output)) return

    const filtered: Array<unknown> = []
    let changed = false
    for (const item of output) {
      if (
        item
        && typeof item === "object"
        && !Array.isArray(item)
        && this.isInternalXSearchCall(item as Record<string, unknown>)
      ) {
        changed = true
        continue
      }
      filtered.push(item)
    }
    if (changed) {
      ;(response as Record<string, unknown>).output = filtered
    }
  }
}
