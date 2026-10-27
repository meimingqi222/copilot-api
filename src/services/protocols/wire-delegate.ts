/**
 * 跨 wire 的翻译包装器骨架。
 *
 * `chat ↔ messages`、`chat ↔ responses` 四个包装器此前各写一遍
 * `createTranslatedCall` 的绑定与 executor 转发，只有 source/target、payload
 * 类型和结果类型不同。这里把这段固定骨架收成一个参数化工厂；真正的翻译
 * 语义仍在 `wire-pairs.ts` 与各 codec 里。
 */
import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { IRWire } from "~/services/ir/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createTranslatedCall } from "./wire-pairs"

interface WireDelegateParams<
  TSourcePayload,
  TTargetPayload,
  TTargetResult extends { credentialId: string; response: unknown },
> {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: TSourcePayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  executor: (params: {
    target: RouteTarget
    connection: ProviderConnection
    credential: ApiCredential
    payload: TTargetPayload
    signal?: AbortSignal
    ctx?: RequestExecutionContext
  }) => Promise<TTargetResult>
}

export function createWireDelegate<
  TSourcePayload,
  TTargetPayload,
  TTargetResult extends { credentialId: string; response: unknown },
  TResult,
>(
  source: IRWire,
  target: IRWire,
): (
  params: WireDelegateParams<TSourcePayload, TTargetPayload, TTargetResult>,
) => Promise<TResult> {
  return async (params) => {
    const {
      target: routeTarget,
      connection,
      credential,
      payload,
      signal,
      ctx,
      executor,
    } = params
    return (await createTranslatedCall({
      source,
      target,
      targetPayload: payload,
      connection,
      credential,
      routeTarget,
      signal,
      ctx,
      executor: (p) =>
        executor({
          target: p.target,
          connection: p.connection,
          credential: p.credential,
          payload: p.payload as TTargetPayload,
          signal: p.signal,
          ctx: p.ctx,
        }),
    })) as unknown as TResult
  }
}
