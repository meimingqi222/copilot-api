import { asRecord } from "~/lib/json-shape"
import type { AnthropicWebSearchToolResultBlock } from "~/services/protocols/anthropic/types"

/** CLI search envelopes contain result groups, with URL/title entries in content. */
export function readClaudeSearchResults(
  value: unknown,
):
  | { query: string; content: AnthropicWebSearchToolResultBlock["content"] }
  | undefined {
  const result = asRecord(value)
  if (typeof result?.query !== "string" || !Array.isArray(result.results))
    return undefined
  const content: AnthropicWebSearchToolResultBlock["content"] = []
  for (const group of result.results) {
    const entries = asRecord(group)?.content
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const hit = asRecord(entry)
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
