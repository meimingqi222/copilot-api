import type { AnthropicWebSearchToolResultBlock } from "~/services/protocols/anthropic/types"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** CLI search envelopes contain result groups, with URL/title entries in content. */
export function readClaudeSearchResults(
  value: unknown,
):
  | { query: string; content: AnthropicWebSearchToolResultBlock["content"] }
  | undefined {
  const result = record(value)
  if (typeof result?.query !== "string" || !Array.isArray(result.results))
    return undefined
  const content: AnthropicWebSearchToolResultBlock["content"] = []
  for (const group of result.results) {
    const entries = record(group)?.content
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const hit = record(entry)
      if (typeof hit?.url !== "string") continue
      content.push({
        type: "web_search_result",
        url: hit.url,
        ...(typeof hit.title === "string" ? { title: hit.title } : {}),
      })
    }
  }
  return { query: result.query, content }
}
