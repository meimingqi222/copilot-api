export function computeStreamingTiming(
  streamStart: number,
  firstChunkTs: number | undefined,
  completionTokens: number,
): { ttftMs: number; tps: number } | undefined {
  if (!firstChunkTs || streamStart === 0) {
    return undefined
  }
  const ttftMs = firstChunkTs - streamStart
  const generationMs = Date.now() - firstChunkTs
  const tps = generationMs > 0 ? completionTokens / (generationMs / 1000) : 0
  return { ttftMs, tps }
}
