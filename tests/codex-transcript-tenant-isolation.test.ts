import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"
import {
  clearCodexTranscriptsForTest,
  codexTranscriptKey,
  getCodexTranscript,
} from "~/services/codex/ws-transcript-cache"

/**
 * P1 (isolation-critical): the transcript recovery cache must work for pure
 * HTTP clients that supply a stable session id (prompt_cache_key or
 * session_id header), must stay off for clients that don't (the turn-1
 * content-hash fallback must never gate a write — it can collide across
 * unrelated conversations), and must never let two tenant scopes read each
 * other's transcript even when they share the same client-supplied
 * prompt_cache_key value.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearCodexTranscriptsForTest()
})

function makeAccount(): Account {
  return {
    id: "codex-shared-account",
    label: "codex",
    provider: "codex",
    credentials: {
      type: "oauth",
      accessToken: "tok",
      accountId: "acct-1",
      expiresAt: Date.now() + 100_000,
    },
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
  }
}

function sseCompleted(responseId: string, outputText: string): Response {
  return new Response(
    [
      `data: {"type":"response.created","response":{"id":"${responseId}","status":"in_progress"}}`,
      "",
      `data: {"type":"response.completed","response":{"id":"${responseId}","status":"completed","model":"gpt-5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${outputText}"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/** Runs one createCodexResponsesOnce call over the plain HTTP path and returns the posted upstream body (or throws). */
async function runHttpTurn(
  payload: Record<string, unknown>,
  ctx: RequestExecutionContext,
  responseId: string,
  outputText: string,
): Promise<Record<string, unknown>> {
  let postedBody: Record<string, unknown> | undefined
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    postedBody = JSON.parse(init.body as string) as Record<string, unknown>
    return Promise.resolve(sseCompleted(responseId, outputText))
  }) as typeof fetch

  const stream = await createCodexResponsesOnce(
    makeAccount(),
    payload as never,
    undefined,
    ctx,
  )
  for await (const _e of stream as AsyncIterable<unknown>) {
    // drain so transcript recording (on response.completed) completes
  }
  if (!postedBody) throw new Error("upstream body was never captured")
  return postedBody
}

/** Asserts a `runHttpTurn` call rejects with the 409 recovery-required error. */
async function expectPreviousResponseNotFound(
  payload: Record<string, unknown>,
  ctx: RequestExecutionContext,
  responseId: string,
  outputText: string,
): Promise<void> {
  let caught: unknown
  try {
    await runHttpTurn(payload, ctx, responseId, outputText)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(HTTPError)
  expect((caught as HTTPError).response.status).toBe(409)
  expect((caught as HTTPError).message).toContain("previous_response_not_found")
}

describe("codex transcript recovery — pure HTTP client, no downstream WebSocket", () => {
  test("(a) HTTP client with prompt_cache_key: chained turn is transparently recovered, no 409", async () => {
    const scope = "user:alice"
    const promptCacheKey = "shared-cache-key"

    await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "turn1 question" }],
          },
        ],
      },
      { transcriptScopeId: scope, forwardedHeaders: {} },
      "resp_1",
      "turn1 answer",
    )

    // Chained turn: only the incremental delta + previous_response_id, as a
    // real HTTP client (e.g. Crush) would send after a WS-only response ID.
    const turn2Body = await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "turn2 question" }],
          },
        ],
      },
      { transcriptScopeId: scope, forwardedHeaders: {} },
      "resp_2",
      "turn2 answer",
    )

    expect(Object.hasOwn(turn2Body, "previous_response_id")).toBe(false)
    const texts = (
      turn2Body.input as Array<{
        content?: Array<{ text?: string }>
      }>
    ).map((item) => item.content?.[0]?.text)
    expect(texts).toEqual(["turn1 question", "turn1 answer", "turn2 question"])
  })

  test("(b) HTTP client without any client-supplied session id: no transcript write, chained turn still 409s", async () => {
    const ctx: RequestExecutionContext = { forwardedHeaders: {} }

    // Turn 1 completes normally but must not have written a transcript
    // (there is no stable id to key it on — only the turn-1 content hash,
    // which must never gate a write).
    await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello, no session id" }],
          },
        ],
      },
      ctx,
      "resp_1",
      "turn1 answer",
    )

    // A chained follow-up with no recoverable transcript must hit the
    // documented 409 recovery-required error, not silently misbehave. Two
    // attempts, to also confirm the (missing) transcript stays missing.
    await expectPreviousResponseNotFound(
      {
        model: "gpt-5",
        stream: true,
        previous_response_id: "resp_1",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "ok" },
        ],
      },
      ctx,
      "resp_2",
      "turn2 answer",
    )
    await expectPreviousResponseNotFound(
      {
        model: "gpt-5",
        stream: true,
        previous_response_id: "resp_1",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "ok" },
        ],
      },
      ctx,
      "resp_3",
      "turn3 answer",
    )
  })

  test("(c) isolation: two tenant scopes sharing the same prompt_cache_key never read each other's transcript", async () => {
    const promptCacheKey = "shared-cache-key-multi-tenant"

    await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "alice turn1 secret" }],
          },
        ],
      },
      { transcriptScopeId: "user:alice", forwardedHeaders: {} },
      "resp_alice_1",
      "alice turn1 answer",
    )

    await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "bob turn1 hello" }],
          },
        ],
      },
      { transcriptScopeId: "user:bob", forwardedHeaders: {} },
      "resp_bob_1",
      "bob turn1 answer",
    )

    // Bob chains from *his own* previous_response_id. If scope isolation were
    // broken, this replay could pull in Alice's "secret" turn instead.
    const bobTurn2 = await runHttpTurn(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        previous_response_id: "resp_bob_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "bob turn2 followup" }],
          },
        ],
      },
      { transcriptScopeId: "user:bob", forwardedHeaders: {} },
      "resp_bob_2",
      "bob turn2 answer",
    )

    const bobSerialized = JSON.stringify(bobTurn2.input)
    expect(bobSerialized).not.toContain("alice")
    expect(bobSerialized).toContain("bob turn1 hello")
    expect(bobSerialized).toContain("bob turn2 followup")

    // Direct key-level check: same prompt_cache_key, different scope prefix,
    // different transcript entries — Bob's stored transcript never contains
    // Alice's content and vice versa.
    const aliceKey = codexTranscriptKey(`user:alice::${promptCacheKey}`)
    const bobKey = codexTranscriptKey(`user:bob::${promptCacheKey}`)
    expect(aliceKey).not.toBe(bobKey)
    expect(JSON.stringify(getCodexTranscript(bobKey))).not.toContain("alice")
    expect(JSON.stringify(getCodexTranscript(aliceKey))).not.toContain("bob")

    // A third tenant who never wrote anything of her own cannot piggyback on
    // Bob's response id just because it shares the same prompt_cache_key —
    // her scope key is empty, so this must hit the 409, not silently
    // surface Bob's transcript.
    await expectPreviousResponseNotFound(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        previous_response_id: "resp_bob_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "carol tries bob's id" }],
          },
        ],
      },
      { transcriptScopeId: "user:carol", forwardedHeaders: {} },
      "resp_carol_1",
      "carol turn answer",
    )
  })

  // Not every entry point establishes a tenant scope. The chat→responses
  // bridge (`services/dispatch/shared.ts` responsesExecutor, whose
  // executionContext is built in `routes/chat-completions/handler.ts`)
  // forwards `session_id` / `prompt_cache_key` headers but no
  // transcriptScopeId. A stable-looking session id is NOT sufficient on its
  // own: without a scope there is nothing distinguishing two principals who
  // send the same id, so the key would be shared across tenants. Fail closed —
  // no scope means no transcript, degrading to the documented 409 rather than
  // replaying another principal's turns.
  test("(d) no tenant scope in the execution context: never writes an unscoped transcript", async () => {
    const promptCacheKey = "no-scope-shared-key"
    const sessionHeaderId = "no-scope-session-header"

    for (const [payloadExtra, ctx] of [
      [{ prompt_cache_key: promptCacheKey }, { forwardedHeaders: {} }],
      [{}, { forwardedHeaders: { session_id: sessionHeaderId } }],
    ] as const) {
      await runHttpTurn(
        {
          model: "gpt-5",
          stream: true,
          ...payloadExtra,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "tenant A private turn" }],
            },
          ],
        },
        ctx as RequestExecutionContext,
        "resp_1",
        "answer",
      )
    }

    expect(
      getCodexTranscript(codexTranscriptKey(promptCacheKey)),
    ).toBeUndefined()
    expect(
      getCodexTranscript(codexTranscriptKey(sessionHeaderId)),
    ).toBeUndefined()

    // A second principal sending the same id chains from its own response id
    // and must not be handed the first principal's turns.
    await expectPreviousResponseNotFound(
      {
        model: "gpt-5",
        stream: true,
        prompt_cache_key: promptCacheKey,
        previous_response_id: "resp_1",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "ok" },
        ],
      },
      { forwardedHeaders: {} },
      "resp_2",
      "answer",
    )
  })
})
