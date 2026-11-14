import type { AnthropicWebSearchToolResultBlock } from "~/services/protocols/anthropic/types"
import type { IRWebSearchResultPart } from "~/services/ir/types"

/**
 * IR web-search result part → Anthropic `web_search_tool_result` block.
 * Shared by the messages-chat request, response and stream encoders so the
 * block shape (and its optional-field spellings) lives in one place.
 */
export function webSearchResultBlock(
  part: IRWebSearchResultPart,
): AnthropicWebSearchToolResultBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: part.toolUseId,
    content: part.results.map((result) => ({
      type: "web_search_result",
      url: result.url,
      ...(result.title && { title: result.title }),
      ...(result.pageAge && { page_age: result.pageAge }),
      ...(result.encryptedContent && {
        encrypted_content: result.encryptedContent,
      }),
    })),
  }
}
