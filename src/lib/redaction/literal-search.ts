/** Capacity rejection, never a reason to send partially masked text upstream. */
export class LiteralSearchLimitError extends Error {
  constructor() {
    super("Redaction literal search capacity exceeded")
  }
}

const MAX_NODES = 256 * 1024
const MAX_MATCHES = 64 * 1024
const MAX_WORK = 8 * 1024 * 1024

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
 */
export function scanLiterals<T>(
  text: string,
  values: ReadonlyMap<string, T>,
  visit: (value: T, start: number, end: number) => void,
): void {
  if (values.size === 0) return
  let hits = 0
  const emit = (value: T, start: number, end: number) => {
    if (++hits > MAX_MATCHES) throw new LiteralSearchLimitError()
    visit(value, start, end)
  }
  // A constant number of native searches is faster and avoids building a huge
  // trie for a single long secret field. Never scale this branch with entries.
  if (values.size <= 8) {
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

  let work = 0
  const step = () => {
    if (++work > MAX_WORK) throw new LiteralSearchLimitError()
  }
  const entries = [...values]
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
        if (nodes.length >= MAX_NODES) throw new LiteralSearchLimitError()
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
