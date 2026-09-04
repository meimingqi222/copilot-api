/**
 * xAI Responses 请求体清洗模块的聚合入口。
 * 从 `sanitize-body.ts` 拆分而来，纯代码移动，无行为变更。
 */

import {
  collectXaiClientDeclaredTools,
  xaiRequestHasNativeXSearch,
} from "~/services/xai/search-filter"

export type { XaiNamespaceToolRef } from "./namespace-tools"

export {
  collectXaiNamespaceToolRefs,
  restoreXaiNamespaceToolCalls,
} from "./namespace-tools"
export { isValidXaiEncryptedContent } from "./reasoning"
import type { XaiNamespaceToolRef } from "./namespace-tools"

import {
  collectXaiNamespaceToolRefs,
  normalizeXaiInputNamespaceToolCalls,
} from "./namespace-tools"

export { xaiSupportsReasoningEffort } from "~/services/xai/model-metadata"
import {
  sanitizeXaiInputReasoningItems,
  sanitizeXaiReasoningEffort,
} from "./reasoning"
import {
  normalizeXaiInputCustomToolCalls,
  normalizeXaiToolChoiceForTools,
  normalizeXaiToolsAndInput,
} from "./tools"

export type XaiSanitizeResult = {
  body: Record<string, unknown>
  /** qualified name → original { namespace, name }, for response restore. */
  namespaceToolRefs: Map<string, XaiNamespaceToolRef>
  /** Tools declared by the client before normalization */
  clientDeclaredTools: Set<string>
  /** Whether the request uses native x_search */
  hasNativeXSearch: boolean
}

export function sanitizeXaiResponsesBody(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return sanitizeXaiResponsesBodyWithRefs(body, model).body
}

export function sanitizeXaiResponsesBodyWithRefs(
  body: Record<string, unknown>,
  model: string,
): XaiSanitizeResult {
  const namespaceToolRefs = collectXaiNamespaceToolRefs(body)
  const clientDeclaredTools = collectXaiClientDeclaredTools(body)
  const hasNativeXSearch = xaiRequestHasNativeXSearch(body)

  let next = { ...body }

  // stop is Chat Completions-only; xAI Responses rejects it.
  if ("stop" in next) {
    const { stop: _stop, ...rest } = next
    next = rest
  }

  next = sanitizeXaiReasoningEffort(next, model)
  next = normalizeXaiToolsAndInput(next)
  next = normalizeXaiToolChoiceForTools(next)
  next = normalizeXaiInputCustomToolCalls(next)
  next = normalizeXaiInputNamespaceToolCalls(next)
  next = sanitizeXaiInputReasoningItems(next)
  return {
    body: next,
    namespaceToolRefs,
    clientDeclaredTools,
    hasNativeXSearch,
  }
}
