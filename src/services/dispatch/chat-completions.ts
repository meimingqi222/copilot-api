/**
 * Chat Completions 统一调度器。
 *
 * 根据 RequestAdmission 的 kind 决定走 legacy ProviderRuntime 还是新的
 * Protocol Adapter。返回结构与 legacy `createChatCompletions` 保持一致,
 * 调用方(routes/chat-completions/handler.ts)无需感知差异。
 *
 * Failover 策略:
 * - legacy:沿用 `executeProviderRequestWithRetry` 在 runtime 内部处理。
 * - connection:在此层捕获 HTTPError,排除已尝试 target,调用 next 直到耗尽候选。
 */

import consola from "consola"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import {
  DEFAULTS,
  markCredentialCooldown,
  persistProviderConnections,
} from "~/lib/provider-connections"
import {
  switchToNextRouteTarget,
  type RequestAdmission,
} from "~/lib/request-admission"
import { targetKey } from "~/lib/route-target"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export type ChatDispatchResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }

export async function dispatchChatCompletions(
  payload: ChatCompletionsPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
): Promise<ChatDispatchResult> {
  if (admission.kind === "legacy") {
    const result = await createChatCompletions(payload, {
      account: admission.account,
      signal,
      initiatorOverride: admission.initiator,
    })
    return result as ChatDispatchResult
  }

  return await dispatchViaConnection(payload, admission, signal)
}

async function dispatchViaConnection(
  payload: ChatCompletionsPayload,
  admission: Extract<RequestAdmission, { kind: "connection" }>,
  signal?: AbortSignal,
): Promise<ChatDispatchResult> {
  initializeProtocolAdapters()

  const tried = new Set<string>()
  let current: typeof admission = admission

  // 尝试当前 target,失败后按 failover 规则切换。最多遍历所有候选。

  while (true) {
    const adapter = getProtocolAdapter(current.connection.protocol)
    if (!adapter?.createChatCompletions) {
      throw new HTTPError(
        `Protocol "${current.connection.protocol}" does not support chat completions`,
        new Response("Not Implemented", { status: 501 }),
      )
    }

    try {
      const result = await adapter.createChatCompletions(
        current.target,
        current.connection,
        current.credential,
        payload,
        signal,
        { initiator: current.initiator },
      )
      return {
        accountId: result.credentialId,
        response: result.response,
      } as ChatDispatchResult
    } catch (error) {
      if (isAbortError(error)) throw error

      tried.add(targetKey(current.target))

      if (error instanceof HTTPError) {
        if (!shouldFailover(error)) throw error
      } else {
        markCredentialCooldown(current.credential, {
          retryAfterMs: DEFAULTS.COOLDOWN_NETWORK_MS,
          reason: error instanceof Error ? error.message : "network error",
        })
        await persistProviderConnections().catch((err: unknown) => {
          consola.warn(
            "[dispatch/chat] failed to persist credential status:",
            (err as Error).message,
          )
        })
      }

      const next = switchToNextRouteTarget(
        current.target,
        payload.model,
        "chat",
        tried,
      )
      if (!next) throw error
      current = {
        kind: "connection",
        target: next.target,
        connection: next.connection,
        credential: next.credential,
        initiator: current.initiator,
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function shouldFailover(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return false
  const status = error.response.status
  // 401/402/403/429/5xx 可 failover;客户端参数类 4xx 错误不 failover
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return true
  }
  if (status >= 500) return true
  return false
}
