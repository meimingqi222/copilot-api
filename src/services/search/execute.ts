/**
 * Runs one web search through a search-capable account.
 *
 * Codex accounts are preferred because their ChatGPT backend answers
 * Responses `web_search` natively.
 */

import type { RequestExecutionContext } from "~/services/providers/runtime"
import type { ResponsesPayload } from "~/services/protocols/responses/types"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { markCredentialCooldown } from "~/lib/provider-connections"
import {
  checkRateLimit,
  reportUpstreamRateLimitMs,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"
import { getProtocolAdapter } from "~/services/protocols/registry"

import type { SearchAnswer, SearchHit, Searcher } from "./types"

import { describeSearcher } from "./searcher"

export const SEARCH_TIMEOUT_MS = 120_000

const SEARCH_SYSTEM_PROMPT =
  "You are a web search backend. Search the web for the user's query, then "
  + "answer with the concrete facts you found. Be concise and do not ask "
  + "follow-up questions."

/**
 * Context for the internal call.
 *
 * Deliberately free of session/transcript ids: the search turn is not part of
 * the caller's conversation, and reusing those ids would append checkpoints to
 * the caller's Codex transcript cache (`services/codex/create-responses-once`).
 */
function searchContext(initiator?: "agent" | "user"): RequestExecutionContext {
  return { initiator }
}

function objectList(
  value: unknown,
  key: string,
): Array<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object") return undefined
  const found = (value as Record<string, unknown>)[key]
  if (!Array.isArray(found)) return undefined
  return found.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  )
}

function toHit(
  url: unknown,
  title?: unknown,
  pageAge?: unknown,
): SearchHit | undefined {
  if (typeof url !== "string" || !url) return undefined
  return {
    url,
    ...(typeof title === "string" && title && { title }),
    ...(typeof pageAge === "string" && pageAge && { pageAge }),
  }
}

/** Pulls the visited pages out of either wire's search-result structures. */
function collectHits(blocks: Array<Record<string, unknown>>): Array<SearchHit> {
  const hits: Array<SearchHit> = []
  for (const block of blocks) {
    // Anthropic: `web_search_tool_result.content[]` holds the pages.
    for (const item of objectList(block, "content") ?? []) {
      const found = toHit(item.url, item.title, item.page_age)
      if (found) hits.push(found)
    }
    // Responses: `web_search_call.action.sources[]`.
    const action = block.action
    if (action && typeof action === "object") {
      for (const source of objectList(action, "sources") ?? []) {
        const found = toHit(source.url, source.title)
        if (found) hits.push(found)
      }
    }
    // Responses: `annotations[]` on an output_text part.
    for (const annotation of objectList(block, "annotations") ?? []) {
      const found = toHit(annotation.url, annotation.title)
      if (found) hits.push(found)
    }
  }
  return hits
}

function collectText(
  blocks: Array<Record<string, unknown>>,
): string | undefined {
  const parts: Array<string> = []
  for (const block of blocks) {
    if (
      (block.type === "text" || block.type === "output_text")
      && typeof block.text === "string"
    ) {
      parts.push(block.text)
    }
    if (block.type === "message")
      for (const item of objectList(block, "content") ?? [])
        if (typeof item.text === "string") parts.push(item.text)
  }
  const text = parts.join("\n").trim()
  return text || undefined
}

function parseAnswer(body: unknown): SearchAnswer {
  const blocks = [
    ...(objectList(body, "content") ?? []),
    ...(objectList(body, "output") ?? []),
  ]
  const text = collectText(blocks)
  return { ...(text && { text }), hits: collectHits(blocks) }
}

function buildResponsesPayload(
  searcher: Searcher,
  query: string,
): ResponsesPayload {
  return {
    model: searcher.target.upstreamModelId,
    instructions: SEARCH_SYSTEM_PROMPT,
    input: `Search the web for: ${query}`,
    tools: [{ type: "web_search", name: "web_search" }],
    stream: false,
    store: false,
  } as unknown as ResponsesPayload
}

function isAsyncIterable(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  )
}

async function callOnce(
  searcher: Searcher,
  query: string,
  signal: AbortSignal,
  initiator?: "agent" | "user",
): Promise<SearchAnswer> {
  const { connection, credential, target } = searcher
  const ctx = searchContext(initiator)
  // codex-native's adapter `createResponses` is a thin pass-through to this
  // same function, so it is called directly to avoid the extra hop.
  if (connection.protocol === "codex-native") {
    const result = await createCodexResponsesOnce(
      { connection, credential },
      buildResponsesPayload(searcher, query),
      signal,
      ctx,
    )
    if (isAsyncIterable(result))
      throw new HTTPError(
        "Search backend unexpectedly streamed a non-streaming request",
        new Response(null, { status: 502 }),
      )
    return parseAnswer(result)
  }

  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter)
    throw new HTTPError(
      `No adapter registered for search backend "${connection.protocol}"`,
      new Response(null, { status: 502 }),
    )
  const params = { target, connection, credential, signal, ctx }
  if (target.endpoint === "messages") {
    if (!adapter.createMessages)
      throw new HTTPError(
        `Search backend "${connection.protocol}" cannot create messages`,
        new Response(null, { status: 502 }),
      )
    const result = await adapter.createMessages({
      ...params,
      payload: {
        model: target.upstreamModelId,
        max_tokens: 4096,
        system: SEARCH_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Search the web for: ${query}` }],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ],
        stream: false,
      },
    })
    return parseAnswer(result.response)
  }

  if (!adapter.createResponses)
    throw new HTTPError(
      `Search backend "${connection.protocol}" cannot create responses`,
      new Response(null, { status: 502 }),
    )
  const result = await adapter.createResponses({
    ...params,
    payload: buildResponsesPayload(searcher, query),
  })
  return parseAnswer(result.response)
}

/**
 * Executes `query` against the first searcher that answers.
 *
 * Goes straight to the adapter, so the failover loop's rate limiting and
 * credential accounting do not apply — they are replayed here so a throttled
 * searcher is cooled instead of being hammered again on the next request.
 */
export async function executeWebSearch(
  query: string,
  searchers: Array<Searcher>,
  signal?: AbortSignal,
  initiator?: "agent" | "user",
): Promise<SearchAnswer> {
  let lastError: unknown
  for (const searcher of searchers) {
    const connectionId = searcher.connection.id
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      await checkRateLimit(connectionId, combined)
      const answer = await callOnce(searcher, query, combined, initiator)
      await reportUpstreamSuccess(connectionId)
      return answer
    } catch (error) {
      lastError = error
      logger.warn(
        `[search] ${describeSearcher(searcher)} failed (query ${query.length} chars): ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      const status = error instanceof HTTPError ? error.response.status : 0
      if (status === 429) {
        await reportUpstreamRateLimitMs(connectionId)
        continue
      }
      if (status === 401 || status === 403) {
        // Terminal for this credential: cool it so the next request does not
        // repeat the same auth failure.
        markCredentialCooldown(searcher.credential, {
          reason: `search backend auth error (${status})`,
        })
        continue
      }
      // Transport / timeout: try the next searcher instead of failing the turn.
    }
  }
  throw new HTTPError(
    `No search backend could answer the query: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    new Response(null, { status: 502 }),
  )
}
