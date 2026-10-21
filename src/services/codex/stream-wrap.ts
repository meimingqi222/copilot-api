import {
  restoreIdentityConfuseResponse,
  type IdentityConfuseState,
} from "~/lib/cache/identity-confuse"
import { cacheReasoningReplayItems } from "~/lib/cache/reasoning-replay-cache"
import { logger } from "~/lib/logger"
import type { CopilotStreamEventLike } from "~/services/protocols/responses/types"

export function logCodexReasoningSummary(
  label: string,
  output: Array<Record<string, unknown>> | undefined,
): void {
  const reasoningItems = output?.filter((item) => item.type === "reasoning")
  logger.debug(label, {
    outputTypes: output?.map((item) => item.type),
    reasoningItemCount: reasoningItems?.length ?? 0,
    reasoningHasSummary: reasoningItems?.some(
      (item) => Array.isArray(item.summary) && item.summary.length > 0,
    ),
  })
}

function handleCodexStreamCompletion(
  parsed: Record<string, unknown>,
  model: string,
  replaySessionKey: string | undefined,
): void {
  if (
    parsed.type !== "response.completed"
    && parsed.type !== "response.incomplete"
  ) {
    return
  }
  if (replaySessionKey) {
    void cacheReasoningReplayItems(model, replaySessionKey, parsed)
  }
  const output = (
    parsed.response as { output?: Array<Record<string, unknown>> }
  ).output
  logCodexReasoningSummary(`[codex] ${parsed.type} reasoning summary`, output)
}

export async function* wrapCodexStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
  replaySessionKey: string | undefined,
  identityState: IdentityConfuseState,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    let data = event.data
    if (!data || data === "[DONE]") {
      yield event
      continue
    }

    if (
      data.includes('"response.completed"')
      || data.includes('"response.incomplete"')
    ) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        handleCodexStreamCompletion(parsed, model, replaySessionKey)
      } catch {
        // Best-effort caching.
      }
    }

    if (identityState.enabled) {
      data = restoreIdentityConfuseResponse(data, identityState)
    }

    yield { ...event, data }
  }
}
