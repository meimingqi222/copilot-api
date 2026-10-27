/**
 * JSON 形状守卫：把 unknown 收窄成记录/数字。
 *
 * 这些函数原本在二十多个 provider、quota、OAuth 模块里各抄一份，语义完全
 * 相同；统一在这里，解析代码只关心“这是不是我要的形状”。
 */

/** 非 null、非数组的对象；其余（含数组）返回 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** JSON 数字（也接受带空白的数字字符串）；其余返回 undefined。 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** `asRecord`，缺失时返回空记录：调用方要直接读字段时用。 */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {}
}
