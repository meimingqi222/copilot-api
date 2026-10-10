/**
 * Protocol Adapter 注册表(Wire Adapters)。
 *
 * 本注册表注册的是 **wire adapters**(协议适配层),按 ProviderProtocol 注册,
 * connection 根据自身 protocol 字段查找。既有通用 `*-compatible`
 * (openai / openai-responses / anthropic / gemini),也有各家 `*-native`
 * (copilot / claude / codex / xai / kimi / antigravity / windsurf / codebuff /
 * mimo / minimax / codebuddy / lobsterai / qoder / factory / zcode /
 * commandcode / zed / dimagent / gemini-native 等)。
 * 具体清单以 `services/protocols/index.ts` 的注册调用为准。
 *
 * 与 services/providers/registry.ts 的区别:
 * - 本注册表 → wire adapters(协议适配:请求/响应格式转换)
 * - providers/registry → runtimes(生命周期管理:token/quota/model 刷新)
 * 两者是正交维度,不合并。
 */

import type { ProviderProtocol } from "~/lib/provider-connections"
import {
  bindRedactionStream,
  maskUpstream,
  withRedactionIssuer,
} from "~/lib/redaction/context"

import type { ProtocolAdapter } from "./types"

const registry = new Map<ProviderProtocol, ProtocolAdapter>()

export function registerProtocolAdapter(adapter: ProtocolAdapter): void {
  if (registry.has(adapter.protocol)) {
    throw new Error(`Protocol adapter already registered: ${adapter.protocol}`)
  }
  Object.assign(adapter, {
    createChatCompletions:
      adapter.createChatCompletions
      && protect(adapter.createChatCompletions.bind(adapter)),
    createMessages:
      adapter.createMessages && protect(adapter.createMessages.bind(adapter)),
    createResponses:
      adapter.createResponses && protect(adapter.createResponses.bind(adapter)),
    createGeminiGenerateContent:
      adapter.createGeminiGenerateContent
      && protect(adapter.createGeminiGenerateContent.bind(adapter)),
    createEmbeddings:
      adapter.createEmbeddings
      && protect(adapter.createEmbeddings.bind(adapter)),
  })
  registry.set(adapter.protocol, adapter)
}

function protect<
  P extends { payload: unknown; connection: { id: string } },
  R extends { response: unknown },
>(call: (params: P) => Promise<R>): (params: P) => Promise<R> {
  return (params) =>
    withRedactionIssuer(params.connection.id, async () => {
      const result = await call({
        ...params,
        payload: maskUpstream(params.payload),
      })
      const response = result.response
      return (
          response
            && typeof response === "object"
            && Symbol.asyncIterator in response
        ) ?
          {
            ...result,
            response: bindRedactionStream(response as AsyncIterable<unknown>),
          }
        : result
    })
}

export function getProtocolAdapter(
  protocol: ProviderProtocol,
): ProtocolAdapter | undefined {
  return registry.get(protocol)
}
