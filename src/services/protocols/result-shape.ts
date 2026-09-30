/**
 * Shape guards shared by the cross-protocol translation paths.
 *
 * Every wire can deliver either a whole result object or a stream; the two are
 * told apart by `Symbol.asyncIterator` alone. These predicates used to be
 * copy-pasted (under a different local name) into each `*-via-*` wrapper and
 * the IR dispatch table, so they live here once.
 */

/** A stream exposes `Symbol.asyncIterator`; a whole result does not. */
export function isAsyncIterable<T = unknown>(
  value: unknown,
): value is AsyncIterable<T> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  )
}

/** A non-streaming result is a plain object (not an array, not a stream). */
export function isPlainResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !isAsyncIterable(value)
  )
}
