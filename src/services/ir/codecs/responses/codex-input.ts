/**
 * Codex-only Responses input items, decoded for a translated target.
 *
 * Codex sends items and tools no other wire has. Sent to a Chat or Messages
 * account (a failover off an exhausted Codex account onto Windsurf serving
 * the same GPT model, say), each used to refuse the whole request with
 * "Unsupported Responses input item". What they carry is mapped the way
 * magpie maps it (internal/gateway/responses.go, additional_tools.go):
 *
 * - `additional_tools` (Responses Lite): its tools are lifted into the
 *   request's tools, the `functions` namespace Lite groups Codex's own tools
 *   in opened into plain tools, as Codex sends a model that isn't Lite.
 * - `tool_search_call` / `tool_search_output` (client-run tool search): the
 *   search is offered as a `tool_search` function, a call to it goes back as
 *   the `tool_search_call` Codex runs, and the tools a search found are
 *   offered after those sent, as Codex does not send them again.
 * - `configuration_update`: the effort the turn is asked at.
 * - `agent_message` (MultiAgentV2): a user turn for the agent receiving it.
 * - `compaction` / `compaction_summary`: OpenAI's ciphertext, unreadable by
 *   another issuer; dropped with a loss record.
 * - any other item with no equivalent (`local_shell_call`, `item_reference`,
 *   MCP / computer-use items …): dropped with a loss record. Only
 *   `compaction_trigger` is still refused: dropping it would answer a
 *   compaction request with no compaction item.
 */

import type { DecodeLoss, IRPart, IRSource, IRTurn } from "~/services/ir/types"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { asRecord, asString } from "~/lib/json-shape"
import { flatToolName } from "~/services/ir/codecs/responses/tool-names"

type RecordValue = Record<string, unknown>

/** The function name Codex's client-run tool search is offered under. */
export const TOOL_SEARCH_NAME = "tool_search"

/** The namespace Responses Lite groups Codex's own tools in, read as none. */
export const LITE_NAMESPACE = "functions"

const OPAQUE_SUMMARY_ITEMS = new Set(["compaction", "compaction_summary"])
/** Refused, not dropped: see the module comment. */
const REFUSED_ITEMS = new Set(["compaction_trigger"])

export interface CodexInputState {
  source: IRSource
  turns: Array<IRTurn>
  takeReasoning: () => Array<IRPart>
  clearReasoning: () => void
  decodeContent: (value: unknown, path: string) => Array<IRPart>
  /** Tools the input carries: Lite's additional_tools, what searches found. */
  liftedTools: Array<RecordValue>
  losses: Array<DecodeLoss>
  /** The effort a `configuration_update` set; the last one wins. */
  effort?: string
}

/** Arguments of a tool search call, as text whatever shape Codex gave them. */
function searchArguments(value: unknown): string {
  if (typeof value === "string") return value || "{}"
  return JSON.stringify(value ?? {})
}

/** What a model reads of a tool search's result: the tools it may now call. */
function searchFound(tools: Array<RecordValue>): string {
  const names: Array<string> = []
  for (const tool of tools) {
    const name = asString(tool.name)
    if (!name) continue
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        const nestedName = asString(asRecord(nested)?.name)
        if (nestedName) names.push(flatToolName(name, nestedName))
      }
    } else names.push(name)
  }
  return names.length === 0 ?
      "No tools matched the search."
    : `These tools are now available to call: ${names.join(", ")}`
}

function recordsOf(value: unknown): Array<RecordValue> {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((tool): tool is RecordValue => !!tool)
}

/** Lite's tools as the tools a model that isn't Lite is sent. */
function liftLiteTools(item: RecordValue): Array<RecordValue> {
  const lifted: Array<RecordValue> = []
  for (const tool of recordsOf(item.tools)) {
    if (tool.type === "namespace" && tool.name === LITE_NAMESPACE)
      lifted.push(...recordsOf(tool.tools))
    else lifted.push(tool)
  }
  return lifted
}

/**
 * Decodes one Codex-only input item into `state`. Returns false for an item
 * the caller must refuse.
 */
export function decodeCodexInputItem(
  item: RecordValue,
  path: string,
  state: CodexInputState,
): boolean {
  const type = asString(item.type)
  if (!type || REFUSED_ITEMS.has(type)) return false
  switch (type) {
    case "additional_tools":
      state.liftedTools.push(...liftLiteTools(item))
      return true
    case "tool_search_call": {
      const callId = asString(item.call_id)
      if (!callId)
        throw new LocalPayloadUnsupportedError(
          "Malformed Responses tool_search_call",
        )
      state.turns.push({
        role: "assistant",
        source: state.source,
        parts: [
          ...state.takeReasoning(),
          {
            type: "tool_call",
            id: callId,
            name: TOOL_SEARCH_NAME,
            arguments: searchArguments(item.arguments),
            responsesType: "tool_search",
          },
        ],
      })
      return true
    }
    case "tool_search_output": {
      state.clearReasoning()
      const callId = asString(item.call_id)
      const found = recordsOf(item.tools)
      state.liftedTools.push(...found)
      if (callId)
        state.turns.push({
          role: "tool",
          source: state.source,
          parts: [
            {
              type: "tool_result",
              callId,
              content: [{ type: "text", text: searchFound(found) }],
            },
          ],
        })
      return true
    }
    case "configuration_update": {
      const effort = asString(asRecord(item.reasoning)?.effort)
      if (effort) state.effort = effort
      return true
    }
    case "agent_message": {
      state.clearReasoning()
      const parts = state.decodeContent(item.content, `${path}.content`)
      if (parts.length > 0)
        state.turns.push({ role: "user", source: state.source, parts })
      return true
    }
  }
  state.clearReasoning()
  state.losses.push({
    path,
    feature: type,
    action: "drop",
    reason:
      OPAQUE_SUMMARY_ITEMS.has(type) ?
        "opaque compaction summary cannot be replayed to another issuer"
      : "input item has no equivalent on the target wire",
  })
  return true
}

/** Whether a Responses input is Responses Lite (its tools ride in the input). */
export function isLiteInput(input: ReadonlyArray<unknown>): boolean {
  return input.some((item) => asRecord(item)?.type === "additional_tools")
}
