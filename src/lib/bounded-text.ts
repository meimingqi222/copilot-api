/**
 * Helpers for accumulating streamed text under a byte cap.
 *
 * Streaming translators build up response text, reasoning text and tool-call
 * arguments one delta at a time, and each has a MAX_* byte limit. The obvious
 * way to enforce that limit — `Buffer.byteLength(accumulated + delta)` on every
 * delta — is a trap: `+=` produces a rope, and measuring it forces a flatten,
 * so every delta reallocates the entire accumulator. A stream of N deltas then
 * costs O(n^2) time and allocation.
 *
 * With ~1.5MB of reasoning split into per-token deltas that is roughly 30GB of
 * intermediate strings, which is enough to exhaust a 1GB heap. Track the size
 * incrementally instead and the same stream stays linear.
 */

/**
 * Add `delta`'s UTF-8 size to a running byte count, throwing `message` if the
 * result would exceed `maxBytes`. The caller appends `delta` to its own
 * accumulator only after this returns.
 */
export function growByteCount(
  currentBytes: number,
  delta: string,
  maxBytes: number,
  message: string,
): number {
  const nextBytes = currentBytes + Buffer.byteLength(delta)
  if (nextBytes > maxBytes) {
    throw new Error(message)
  }
  return nextBytes
}
