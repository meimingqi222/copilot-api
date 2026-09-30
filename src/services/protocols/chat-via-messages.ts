/**
 * Serves Chat Completions requests via an Anthropic Messages upstream.
 *
 * Thin delegate over {@link createTranslatedCall}. The only per-direction
 * behavior it carries is prompt caching: the Chat Completions schema has no way
 * to express Anthropic `cache_control` breakpoints, so a translated payload
 * would otherwise reach the upstream with none at all — the
 * `anthropic-compatible` adapter forwards the body verbatim and never adds any.
 * That leaves such requests relying on whatever implicit prefix caching the
 * upstream does, measurably below what the direct `/v1/messages` path gets from
 * a client that places its own breakpoints. We place the standard set here
 * instead, via `transformTargetRequest`.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { applyPromptCaching } from "~/services/claude/prompt-cache"

import { createTranslatedCall } from "./wire-pairs"

import type { AnthropicMessagesPayload } from "./anthropic"
import type { AdapterChatResult, AdapterMessagesResult } from "./types"

interface MessagesExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: AnthropicMessagesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

type MessagesExecutor = (
  params: MessagesExecutorParams,
) => Promise<AdapterMessagesResult>

interface ChatViaMessagesParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  messagesExecutor: MessagesExecutor
}

/**
 * Protocols whose own `createMessages` already places cache breakpoints and
 * must keep doing so — `claude-native` mirrors Claude Code's exact layout
 * (billing header + 1h ephemeral TTL) in `create-messages-once`, and
 * pre-seeding breakpoints here would suppress it.
 */
const SELF_CACHING_PROTOCOLS = new Set(["claude-native"])

/**
 * Places the default breakpoint set (last system block + last two messages,
 * capped at 4) on a translated payload. `{ type: "ephemeral" }` uses the
 * default 5m TTL: the 1h TTL needs the `extended-cache-ttl` beta, which a
 * third-party Anthropic-compatible upstream may not accept.
 *
 * `system` is promoted from the translated string to a single text block so it
 * can carry a breakpoint; Anthropic accepts either shape.
 */
function withPromptCacheBreakpoints(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const next: AnthropicMessagesPayload = {
    ...payload,
    ...(typeof payload.system === "string"
      && payload.system.length > 0 && {
        system: [{ type: "text" as const, text: payload.system }],
      }),
  }
  applyPromptCaching(
    next as unknown as Parameters<typeof applyPromptCaching>[0],
    {
      type: "ephemeral",
    },
  )
  return next
}

export async function createChatViaMessages(
  params: ChatViaMessagesParams,
): Promise<AdapterChatResult> {
  const {
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
    messagesExecutor,
  } = params
  const selfCaching = SELF_CACHING_PROTOCOLS.has(target.protocol)
  return (await createTranslatedCall({
    source: "chat",
    target: "messages",
    targetPayload: payload,
    connection,
    credential,
    routeTarget: target,
    signal,
    ctx,
    cacheControlPolicy: selfCaching ? "target" : "caller",
    transformTargetRequest: (encoded) =>
      selfCaching ? encoded : (
        withPromptCacheBreakpoints(encoded as AnthropicMessagesPayload)
      ),
    executor: (p) =>
      messagesExecutor({
        target: p.target,
        connection: p.connection,
        credential: p.credential,
        payload: p.payload as AnthropicMessagesPayload,
        signal: p.signal,
        ctx: p.ctx,
      }),
  })) as unknown as AdapterChatResult
}
