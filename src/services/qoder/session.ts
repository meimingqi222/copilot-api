import { createHash, randomUUID } from "node:crypto"

import { resolveTranscriptScopeId } from "~/lib/request-scope"
import type { ProviderConnection } from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

export interface QoderTask {
  sessionId: string
  id: string
  beginAt: number
  answered: boolean
  usedAt: number
}

const tasks = new Map<string, QoderTask>()
const MAX_TASKS = 512
const TASK_IDLE_MS = 2 * 60 * 60_000

/** One business record per user prompt, not per model call in its tool loop. */
export function getQoderTask(
  payload: ChatCompletionsPayload,
  connection: ProviderConnection,
  ctx?: RequestExecutionContext,
): QoderTask {
  const headers = ctx?.forwardedHeaders
  let named = ctx?.executionSessionId?.trim()
  for (const name of [
    "x-deepseek-harness-session-id",
    "x-session-id",
    "session_id",
    "session-id",
    "x-claude-code-session-id",
    "x-windsurf-session-id",
    "x-antigravity-session-id",
    "x-grok-conv-id",
    "prompt_cache_key",
  ]) {
    named ||= headers?.[name]?.trim() || ctx?.c?.req.header(name)?.trim()
  }
  const cacheKey = payload.prompt_cache_key?.trim()
  const firstUser = payload.messages.find((m) => m.role === "user")
  const seed =
    named ? ["session", named]
    : cacheKey ? ["key", cacheKey]
    : [
        "chat",
        payload.messages.filter(
          (m) => m.role === "system" || m.role === "developer",
        ),
        firstUser?.content ?? "",
      ]
  const scope =
    ctx?.c ?
      resolveTranscriptScopeId(ctx.c)
    : (ctx?.transcriptScopeId ?? "anonymous")
  const digest = createHash("sha256")
    .update(JSON.stringify([scope, connection.id, connection.baseUrl, seed]))
    .digest("hex")
  const sessionId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
  const at = payload.messages.findLastIndex((m) => m.role === "user")
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        sessionId,
        at,
        payload.messages[at]?.content ?? randomUUID(),
      ]),
    )
    .digest("hex")
  const now = Date.now()
  // Access order is also expiry order; store only hashes and protocol ids.
  for (const [oldKey, task] of tasks) {
    if (now - task.usedAt < TASK_IDLE_MS) break
    tasks.delete(oldKey)
  }
  const task = tasks.get(key) ?? {
    sessionId,
    id: randomUUID(),
    beginAt: now,
    answered: false,
    usedAt: now,
  }
  task.usedAt = now
  tasks.delete(key)
  tasks.set(key, task)
  while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value!)
  return task
}
