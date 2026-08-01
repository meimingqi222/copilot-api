import type { Account } from "~/lib/accounts"
import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicTool,
} from "~/services/protocols/anthropic/types"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { getStableSessionId } from "~/lib/cache/session-id-cache"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectAnthropicStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

import { serializeAndPatchCchBody, createClaudeBillingHeader } from "./cch"
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  claudeCodeSystemInstruction,
} from "./fingerprint"
import { buildClaudeOAuthHeaders, getForwardedHeader } from "./headers"
import {
  applyPromptCaching,
  defaultOAuthCacheControl,
  normalizeCacheControlTtlOrdering,
} from "./prompt-cache"
import { applyClaudeToolPrefix, stripClaudeToolPrefix } from "./tool-prefix"
import {
  extractClaudeMetadataSessionId,
  resolveAnthropicMetadataUserId,
} from "./user-id"

const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"

/** Extracts the text of the first user message for the `cch` billing-header fingerprint. */
function firstUserMessageText(payload: AnthropicMessagesPayload): string {
  for (const msg of payload.messages) {
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") return block.text
      }
    }
  }
  return ""
}

/** Normalizes the caller's `system` field into an ordered array of text blocks,
 *  preserving any client-supplied `cache_control` breakpoints. */
function normalizeSystemBlocks(
  payload: AnthropicMessagesPayload,
): Array<AnthropicTextBlock & { cache_control?: unknown }> {
  if (!payload.system) return []
  if (typeof payload.system === "string") {
    return [{ type: "text", text: payload.system }]
  }
  return payload.system.map((block) => {
    const cc = (block as { cache_control?: unknown }).cache_control
    return {
      type: "text" as const,
      text: block.text,
      ...(cc ? { cache_control: cc } : {}),
    }
  })
}

/**
 * Builds the `system` array with the CC billing header at index 0 and the CC
 * system instruction at index 1, followed by the caller's system blocks.
 * Matches oh-my-pi `buildAnthropicSystemBlocks` (OAuth layout). The billing
 * header carries the `cch=00000` placeholder that `patchCch` overwrites after
 * serialization.
 */
function buildSystemBlocks(
  payload: AnthropicMessagesPayload,
  billingHeader: string,
  includeClaudeCodeInstruction = true,
): Array<AnthropicTextBlock & { cache_control?: unknown }> {
  const callerBlocks = normalizeSystemBlocks(payload)
  if (!includeClaudeCodeInstruction) return callerBlocks
  return [
    { type: "text", text: billingHeader },
    { type: "text", text: claudeCodeSystemInstruction },
    ...callerBlocks,
  ]
}

function cloneMessages(
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload["messages"] {
  return structuredClone(messages)
}

/** Test-only helper: builds system blocks + billing header for a payload. */
export function buildClaudeSystemForTest(
  payload: AnthropicMessagesPayload,
): Array<AnthropicTextBlock & { cache_control?: unknown }> {
  return buildSystemBlocks(
    payload,
    createClaudeBillingHeader(firstUserMessageText(payload)),
  )
}

/** True when the caller hides thinking (CC sends `redact-thinking` beta then). */
/** Deep-clones the caller's tools with CC tool-name prefixing applied (OAuth). */
function encodeTools(tools: Array<AnthropicTool>): Array<AnthropicTool> {
  return tools.map((tool) => ({
    ...tool,
    name: applyClaudeToolPrefix(tool.name),
  }))
}

/**
 * Restores original tool names in a non-streaming Anthropic response by
 * stripping the CC `_` prefix from every `tool_use` content block (the
 * inverse of `encodeTools`/`applyClaudeToolPrefix`). Mutates in place.
 */
export function decodeToolNamesInResponse(
  result: Record<string, unknown>,
): void {
  const content = result.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (
      block
      && typeof block === "object"
      && (block as { type?: string }).type === "tool_use"
      && typeof (block as { name?: unknown }).name === "string"
    ) {
      const typed = block as { name: string }
      typed.name = stripClaudeToolPrefix(typed.name)
    }
  }
}

/**
 * Wraps an SSE stream from `safeSseStream`, stripping the CC `_` tool-name
 * prefix from `content_block_start` events whose `content_block.type` is
 * `tool_use`. Other events pass through unchanged.
 */
export async function* decodeToolNamesInStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const event of stream) {
    const raw = event as { data?: string; event?: string }
    if (!raw.data) {
      yield event
      continue
    }
    try {
      const parsed = JSON.parse(raw.data) as {
        type?: string
        content_block?: { type?: string; name?: string }
      }
      if (
        parsed.type === "content_block_start"
        && parsed.content_block?.type === "tool_use"
        && typeof parsed.content_block.name === "string"
      ) {
        parsed.content_block.name = stripClaudeToolPrefix(
          parsed.content_block.name,
        )
        yield { ...raw, data: JSON.stringify(parsed) }
        continue
      }
    } catch {
      // Not JSON or unexpected shape - forward unchanged.
    }
    yield event
  }
}

/**
 * Builds the upstream request body in canonical Claude Code field order, with
 * CC tool-name prefixing, max_tokens clamp, context_management for thinking,
 * and prompt-caching breakpoints.
 *
 * Field order is significant: the `cch` body hash is order-sensitive and the
 * overall wire fingerprint must match CC, which serializes in this order:
 * `model -> messages -> system -> tools -> metadata -> max_tokens -> thinking
 * -> context_management -> output_config -> stream`. Ported from oh-my-pi
 * anthropic.ts canonical params order (3508-3524).
 */
export function buildOrderedBody(
  payload: AnthropicMessagesPayload,
  model: string,
  systemBlocks: Array<AnthropicTextBlock & { cache_control?: unknown }>,
  metadataUserId: string | undefined,
): Record<string, unknown> {
  // OAuth requests clamp max_tokens to CC's ceiling (64k) to match the wire
  // fingerprint; the model ceiling may be higher (e.g. Opus 128k).
  const maxTokens = Math.min(payload.max_tokens, CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  const thinkingEnabled =
    payload.thinking?.type === "enabled"
    || payload.thinking?.type === "adaptive"

  // Tools: apply CC `_` prefix to non-builtin tool names (OAuth fingerprint).
  const encodedTools =
    payload.tools && payload.tools.length > 0 ?
      encodeTools(payload.tools)
    : undefined
  const encodedToolChoice =
    payload.tool_choice?.type === "tool" && payload.tool_choice.name ?
      {
        ...payload.tool_choice,
        name: applyClaudeToolPrefix(payload.tool_choice.name),
      }
    : payload.tool_choice

  // context_management: keep prior thinking blocks across turns (KV cache hits)
  // for any enabled/adaptive thinking request. Requires the
  // `context-management-2025-06-27` beta, which is in the CC agent beta set.
  const hasThinking = thinkingEnabled
  const contextManagement =
    hasThinking ?
      {
        edits: [
          { type: "clear_thinking_20251015" as const, keep: "all" as const },
        ],
      }
    : undefined

  const body: Record<string, unknown> = {
    model,
    messages: cloneMessages(payload.messages),
    system: systemBlocks,
  }
  body.tools = encodedTools ?? []
  if (metadataUserId !== undefined) {
    body.metadata = { user_id: metadataUserId }
  }
  body.max_tokens = maxTokens
  if (payload.thinking) {
    body.thinking = payload.thinking
  }
  if (contextManagement) {
    body.context_management = contextManagement
  }
  if (payload.output_config) {
    body.output_config = payload.output_config
  }
  if (payload.stream) {
    body.stream = true
  }
  if (payload.stop_sequences && payload.stop_sequences.length > 0) {
    body.stop_sequences = payload.stop_sequences
  }
  if (encodedToolChoice) {
    body.tool_choice = encodedToolChoice
  }
  if (!thinkingEnabled && payload.temperature !== undefined) {
    body.temperature = payload.temperature
  }
  if (!thinkingEnabled && payload.top_p !== undefined) {
    body.top_p = payload.top_p
  }
  if (!thinkingEnabled && payload.top_k !== undefined) {
    body.top_k = payload.top_k
  }
  if (payload.service_tier) {
    body.service_tier = payload.service_tier
  }
  if (payload.reasoning_effort !== undefined) {
    body.reasoning_effort = payload.reasoning_effort
  }

  // Prompt caching: OAuth defaults to 1h ephemeral retention (matches CC).
  // Place up to 4 breakpoints (CC layout: last system block + last message),
  // then normalize TTL ordering so 5m never precedes 1h.
  applyPromptCaching(
    body as unknown as Parameters<typeof applyPromptCaching>[0],
    defaultOAuthCacheControl(),
  )
  normalizeCacheControlTtlOrdering(
    body as unknown as Parameters<typeof normalizeCacheControlTtlOrdering>[0],
  )

  return body
}

export async function createClaudeMessagesOnce(
  account: Account,
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  ctx?: {
    forwardedHeaders?: Record<string, string | undefined>
  },
): Promise<AsyncIterable<unknown> | Record<string, unknown>> {
  if (!isOAuthAccount(account) || account.provider !== "claude") {
    throw new Error(`Claude messages requires a Claude OAuth account`)
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(
      `Claude access token missing for account "${account.label}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const isStream = Boolean(payload.stream)

  // Resolve one session id for both the metadata envelope and the transport
  // header. This mirrors Claude Code's session attribution behavior.
  const forwardedHeaders = ctx?.forwardedHeaders
  const forwardedSessionId = getForwardedHeader(
    forwardedHeaders,
    "x-claude-code-session-id",
  )
  const metadataSessionId = extractClaudeMetadataSessionId(
    payload.metadata?.user_id,
  )
  const accountId = account.credentials?.accountId
  const effectiveSessionId =
    forwardedSessionId?.trim()
    || metadataSessionId
    || (await getStableSessionId(account.id))

  // --- Fingerprint body construction (CC stealth) -------------------------
  const includeClaudeCodeInstruction = !model.startsWith("claude-3-5-haiku")
  const billingHeader = createClaudeBillingHeader(firstUserMessageText(payload))
  const systemBlocks =
    includeClaudeCodeInstruction ?
      buildSystemBlocks(payload, billingHeader, true)
    : normalizeSystemBlocks(payload)
  const metadataUserId = await resolveAnthropicMetadataUserId(
    payload.metadata?.user_id,
    true, // OAuth-only path
    effectiveSessionId,
    accountId,
  )
  const orderedBody = buildOrderedBody(
    payload,
    model,
    systemBlocks,
    metadataUserId,
  )

  // Serialize + patch the cch attestation in place (only bodies containing the
  // billing-header placeholder are touched). An unanchored placeholder is a
  // fingerprint regression; we ship `cch=00000` rather than failing, matching
  // CC's prior behaviour, but log it instead of failing silently.
  const bodyBytes = serializeAndPatchCchBody(orderedBody, () => {
    console.warn(
      "claude: cch billing placeholder present but not patched; sending unattested request",
    )
  })

  // --- Headers (CC fingerprint + enforced hygiene) ------------------------
  const forwarded = ctx?.forwardedHeaders
  const headers = await buildClaudeOAuthHeaders({
    accessToken,
    stream: isStream,
    anthropicBeta: getForwardedHeader(forwarded, "anthropic-beta"),
    // anthropic-version is intentionally NOT forwarded; pinned to CC's value.
    sessionId: effectiveSessionId,
    agentRequest:
      Boolean(payload.tools?.length)
      || payload.thinking?.type === "enabled"
      || payload.thinking?.type === "adaptive",
    thinkingRequest:
      payload.thinking?.type === "enabled"
      || payload.thinking?.type === "adaptive"
      || payload.output_config?.effort !== undefined,
    credentialKey: account.id,
  })

  const response = await fetchWithOAuthProxy(account, CLAUDE_MESSAGES_URL, {
    method: "POST",
    headers,
    body: bodyBytes,
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Claude messages",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (isStream) {
    const rawStream = await safeSseStream(response, detectAnthropicStreamError)
    return decodeToolNamesInStream(rawStream)
  }

  const result = (await response.json()) as Record<string, unknown>
  decodeToolNamesInResponse(result)
  return result
}
