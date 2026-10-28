/** Capacity rejection, never a reason to send partially masked text upstream. */
export class LiteralSearchLimitError extends Error {
  constructor() {
    super("Redaction literal search capacity exceeded")
  }
}

interface LiteralSearchLimits {
  maxNodes: number
  maxMatches: number
  maxWork: number
  /**
   * Upper bound for `text.length * values.size` on the native-search path.
   * Native `indexOf` is much cheaper per byte than the trie, so a small value
   * set with long literals (a handful of pasted credentials) must not build a
   * 100 MB index. The multiplier is a work estimate, not an exact cost: it
   * keeps the fast path bounded while staying far above ordinary requests.
   */
  nativeWork: number
}

const DEFAULT_LIMITS: LiteralSearchLimits = {
  maxNodes: 256 * 1024,
  maxMatches: 64 * 1024,
  maxWork: 8 * 1024 * 1024,
  nativeWork: 256 * 1024 * 1024,
}

let limits: LiteralSearchLimits = DEFAULT_LIMITS

/** Test seam: shrink a budget so the capacity paths can be exercised cheaply. */
export function __setLiteralSearchLimitsForTest(
  overrides: Partial<LiteralSearchLimits>,
): void {
  limits = { ...limits, ...overrides }
}

/** Test seam: restore the production budgets. */
export function __resetLiteralSearchLimitsForTest(): void {
  limits = DEFAULT_LIMITS
}

interface Node {
  next: Map<string, number>
  fail: number
  output: number
  terminal: number
}

function node(): Node {
  return { next: new Map(), fail: 0, output: -1, terminal: -1 }
}

/**
 * Aho-Corasick: scan once for many distinct literals, including overlapping
 * prefixes and suffixes. Output links avoid copying every suffix into each node.
 * Work, index size and output are bounded independently of tenant storage.
 *
 * The visitor may return `false` to reject a candidate (a HOME match that is
 * only a path prefix, for example). Rejected candidates do not consume the
 * match budget; only matches the caller actually accepts count toward it.
 */
export function scanLiterals<T>(
  text: string,
  values: ReadonlyMap<string, T>,
  visit: (value: T, start: number, end: number) => boolean | void,
): void {
  if (values.size === 0) return
  let hits = 0
  const emit = (value: T, start: number, end: number) => {
    if (visit(value, start, end) === false) return
    if (++hits > limits.maxMatches) throw new LiteralSearchLimitError()
  }
  // A constant number of native searches is faster and avoids building a huge
  // trie for a single long secret field. The same applies when `values` is
  // large but the text is short: `text.length * values.size` is a work estimate
  // for the native path, and below the budget it is cheaper than a 100 MB trie.
  // The bound is the same for every value count; a large text with many values
  // goes through the trie (or a capacity error) instead.
  if (text.length * values.size <= limits.nativeWork) {
    for (const [literal, value] of values) {
      if (!literal) continue
      let from = 0
      while (true) {
        const start = text.indexOf(literal, from)
        if (start < 0) break
        from = start + literal.length
        emit(value, start, from)
      }
    }
    return
  }

  const entries = [...values]
  let totalLiteralLength = 0
  for (const [literal] of entries) totalLiteralLength += literal.length
  // A scan that cannot fit the work budget would abort mid-way after the trie
  // has already been built. Reject it before allocating the index.
  if (text.length + totalLiteralLength > limits.maxWork) {
    throw new LiteralSearchLimitError()
  }

  let work = 0
  const step = () => {
    if (++work > limits.maxWork) throw new LiteralSearchLimitError()
  }
  const nodes = [node()]
  for (let index = 0; index < entries.length; index++) {
    const literal = entries[index][0]
    if (!literal) continue
    let state = 0
    // UTF-16 code units keep offsets compatible with RegExp and string.slice.
    for (let i = 0; i < literal.length; i++) {
      step()
      const character = literal[i]
      let next = nodes[state].next.get(character)
      if (next === undefined) {
        if (nodes.length >= limits.maxNodes) throw new LiteralSearchLimitError()
        next = nodes.length
        nodes.push(node())
        nodes[state].next.set(character, next)
      }
      state = next
    }
    nodes[state].terminal = index
  }

  const queue = [...nodes[0].next.values()]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    for (const [character, child] of nodes[current].next) {
      step()
      let fallback = nodes[current].fail
      while (fallback && !nodes[fallback].next.has(character)) {
        step()
        fallback = nodes[fallback].fail
      }
      const fail = nodes[fallback].next.get(character) ?? 0
      nodes[child].fail = fail
      nodes[child].output =
        nodes[fail].terminal >= 0 ? fail : nodes[fail].output
      queue.push(child)
    }
  }

  const lastEnds = Array.from({ length: entries.length }, () => 0)
  let state = 0
  for (let i = 0; i < text.length; i++) {
    step()
    const character = text[i]
    while (state && !nodes[state].next.has(character)) {
      step()
      state = nodes[state].fail
    }
    state = nodes[state].next.get(character) ?? 0
    let output = nodes[state].terminal >= 0 ? state : nodes[state].output
    while (output >= 0) {
      step()
      const index = nodes[output].terminal
      const [literal, value] = entries[index]
      const end = i + 1
      const start = end - literal.length
      // Preserve indexOf's non-overlapping occurrences for each literal.
      if (start >= lastEnds[index]) {
        lastEnds[index] = end
        emit(value, start, end)
      }
      output = nodes[output].output
    }
  }
}
