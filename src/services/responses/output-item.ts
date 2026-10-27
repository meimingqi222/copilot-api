/**
 * Responses output item 的去重键：优先 `id`，其次 `call_id`，都带 `type` 前缀。
 *
 * replay（transcript）、流式收集与归一化三条路必须算出同一个键，否则同一个
 * item 会在回放里出现两次。
 */
export function outputItemKey(
  item: Record<string, unknown>,
): string | undefined {
  const type = typeof item.type === "string" ? item.type.trim() : ""
  const id = typeof item.id === "string" ? item.id.trim() : ""
  if (id) return `${type}:id:${id}`
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : ""
  return callId ? `${type}:call_id:${callId}` : undefined
}
