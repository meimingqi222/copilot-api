import { tokenPattern } from "~/lib/redaction/token"

export interface RedactionExcerpt {
  path: string
  text: string
}

/** Keep hit context independently of the prompt prefix, with a separate bound. */
export function redactionExcerpts(value: unknown): {
  items: Array<RedactionExcerpt>
  truncated: boolean
} {
  const items: Array<RedactionExcerpt> = []
  let remaining = 4096
  let nodes = 0
  let truncated = false
  const visit = (node: unknown, path: string, depth: number): void => {
    if (++nodes > 4096 || depth > 16 || remaining <= 0 || items.length >= 16) {
      truncated = true
      return
    }
    if (typeof node === "string") {
      for (const match of node.matchAll(tokenPattern())) {
        const start = Math.max(0, match.index - 120)
        const end = Math.min(node.length, match.index + match[0].length + 120)
        const text = `${start ? "…" : ""}${node.slice(start, end)}${end < node.length ? "…" : ""}`
        if (path.length + text.length > remaining || items.length >= 16) {
          truncated = true
          break
        }
        items.push({ path, text })
        remaining -= path.length + text.length
      }
      return
    }
    if (!node || typeof node !== "object") return
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue
      if (nodes >= 4096 || remaining <= 0 || items.length >= 16) {
        truncated = true
        break
      }
      const item = (node as Record<string, unknown>)[key]
      const child =
        Array.isArray(node) ?
          `[${key}]`
        : `[${JSON.stringify(key.slice(0, 128))}]`
      const nextPath = path + child
      visit(
        item,
        nextPath.length > 256 ? nextPath.slice(0, 255) + "…" : nextPath,
        depth + 1,
      )
    }
  }
  visit(value, "$", 0)
  return { items, truncated }
}
