/**
 * 解析 Retry-After header,支持 delta-seconds 和 HTTP-date 两种格式。
 * @param header Retry-After header 值
 * @param maxMs  返回值的上限(毫秒)。不传则不封顶。
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  maxMs?: number,
): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    const ms = Math.round(asNumber * 1000)
    return maxMs !== undefined ? Math.min(ms, maxMs) : ms
  }
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    const delta = Math.max(asDate - Date.now(), 0)
    return maxMs !== undefined ? Math.min(delta, maxMs) : delta
  }
  return undefined
}
