export function computeStreamingTiming(
  streamStart: number,
  firstChunkTs: number | undefined,
  completionTokens: number,
): { ttftMs: number; tps: number } | undefined {
  if (!firstChunkTs || streamStart === 0) {
    return undefined
  }
  const ttftMs = firstChunkTs - streamStart
  const totalMs = Date.now() - streamStart
  const tps = totalMs > 0 ? completionTokens / (totalMs / 1000) : 0
  return { ttftMs, tps }
}
