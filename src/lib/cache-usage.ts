export interface CacheCreationUsage {
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}

export function cacheCreationFor1h(
  total: number | undefined,
  oneHour: number | undefined,
): CacheCreationUsage | undefined {
  if (oneHour === undefined) return undefined
  const hour = Math.max(0, Math.min(oneHour, total ?? oneHour))
  return {
    ephemeral_5m_input_tokens: Math.max(0, (total ?? hour) - hour),
    ephemeral_1h_input_tokens: hour,
  }
}
