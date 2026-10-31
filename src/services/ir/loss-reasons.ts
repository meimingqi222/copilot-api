/**
 * Loss reason vocabulary — the single source for what a translation loss can
 * say, and the stable code it is recorded under.
 *
 * `LossRecord.reason` is the human-readable sentence assembled by
 * `capabilities.ts`; it is both logged and shown to a client when a request is
 * rejected, so the sentence is part of the contract. The telemetry side must
 * stay low-cardinality, so each sentence carries one stable code.
 *
 * Adding a loss means adding it here: `LossReason` is a union of these keys, so
 * a new sentence in the planner fails to typecheck instead of silently
 * degrading to `unspecified` in the metrics (which is how this table drifted
 * from the planner before).
 */

/** Sentence a translation-loss record carries (also shown to a rejected client). */
export const LOSS_REASONS = {
  "allowed_tools names an undeclared tool": "undeclared_allowed_tool",
  "required allowed_tools set is empty": "empty_required_tools",
  "tool names collide after target mapping": "tool_name_collision",
  "target cannot receive images": "images_unsupported",
  "target cannot receive tool-result images": "tool_result_images_unsupported",
  "move image to the following user content while retaining call order":
    "tool_image_repositioned",
  "target cannot receive file content": "files_unsupported",
  "file ID cannot be resolved by this target": "file_id_issuer_mismatch",
  "thinking text changed after signing": "signed_text_changed",
  "thinking signature belongs to another issuer": "signature_issuer_mismatch",
  "signature is not valid for the target wire": "signature_wire_mismatch",
  "target cannot replay Anthropic signature; retain readable reasoning only":
    "signature_not_replayed",
  "historical thinking without a valid signature cannot be replayed":
    "unsigned_thinking_dropped",
  "opaque reasoning cannot be replayed to another issuer":
    "encrypted_reasoning_issuer_mismatch",
  "target has no explicit cache breakpoint": "cache_breakpoint_unsupported",
  "target places its own cache breakpoints": "target_managed_cache",
  "flatten namespace with a reversible request-level mapping":
    "namespace_flattened",
  "target cannot enforce allowed tool subset":
    "allowed_tool_subset_unsupported",
  "filter declarations before applying target tool choice":
    "allowed_tools_filtered",
  "target has no native or orchestrated web search": "web_search_unsupported",
  "proxy runs the search loop against a search-capable account":
    "web_search_orchestrated",
  "target cannot perform a server-side tool call":
    "server_tool_use_unsupported",
  "historical server tool call cannot be replayed to this target":
    "server_tool_use_history_dropped",
  "target cannot receive web search results": "web_search_results_unsupported",
  "historical web search results cannot be replayed to this target":
    "web_search_results_history_dropped",
  "reasoning effort mapped to nearest Messages level":
    "effort_mapped_to_messages",
  "reasoning effort represented by omitted Messages thinking config":
    "effort_omitted_for_messages",
  "Responses target cannot express requested reasoning effort":
    "effort_unsupported_by_responses",
  "target wire cannot express the requested service tier":
    "service_tier_unsupported",
  "target wire codec cannot encode the requested structured output format":
    "structured_output_unsupported",
} as const satisfies Readonly<Record<string, string>>

/** A reason the planner may record. */
export type LossReason = keyof typeof LOSS_REASONS

/** The stable, low-cardinality code a reason is recorded under. */
export function lossReasonCode(reason: string): string {
  return reason in LOSS_REASONS ?
      LOSS_REASONS[reason as LossReason]
    : "unspecified"
}
