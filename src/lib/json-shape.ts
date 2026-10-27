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

/** 非空字符串（按 trim 判断）；其余返回 false。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** 字符串原样返回；其余 undefined。 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** trim 后非空的字符串；其余 undefined。 */
export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** 字符串原样返回；其余空串。适合直接拼 JSON / 比较的读取点。 */
export function asStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** trim 后的字符串；其余空串。 */
export function asTrimmedStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
