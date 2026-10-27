/**
 * 委托型原生适配器工厂。
 *
 * Command Code / Factory / DimAgent 的适配器不重新实现 wire：它们改写
 * baseUrl 与请求头后，把请求交给既有的 compatible adapter。这里把「改写
 * 连接 → 调基础 adapter」的骨架收成一份；`rewrite` 按 wire 决定路径与头。
 */
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
} from "~/lib/provider-connections"

import type { ProtocolAdapter } from "./types"

export type RewrittenWire = "chat" | "messages" | "responses" | "embeddings"

type RewrittenTarget = {
  connection: ProviderConnection
  credential: ApiCredential
}

type Rewrite = (
  wire: RewrittenWire,
  target: RewrittenTarget,
  signal?: AbortSignal,
) => RewrittenTarget | Promise<RewrittenTarget>

export function createRewrittenAdapter(input: {
  protocol: ProviderProtocol
  rewrite: Rewrite
  /** 本适配器实现的 wire（构造时只读这份列表，不触碰 adapter 绑定）。 */
  wires: ReadonlyArray<RewrittenWire>
  /** 延迟取基础 adapter：它们与本模块互相 import，构造期读会命中 TDZ。 */
  adapters: () => Partial<Record<RewrittenWire, ProtocolAdapter>>
  discoverModels?: ProtocolAdapter["discoverModels"]
}): ProtocolAdapter {
  const adapter: ProtocolAdapter = { protocol: input.protocol }
  if (input.discoverModels) adapter.discoverModels = input.discoverModels

  const delegate =
    <
      TParams extends {
        connection: ProviderConnection
        credential: ApiCredential
        signal?: AbortSignal
      },
    >(
      wire: RewrittenWire,
      method:
        | "createChatCompletions"
        | "createMessages"
        | "createResponses"
        | "createEmbeddings",
    ) =>
    async (params: TParams): Promise<unknown> => {
      const rewritten = await input.rewrite(wire, params, params.signal)
      const target = input.adapters()[wire]?.[method] as
        | ((p: TParams) => Promise<unknown>)
        | undefined
      if (!target) {
        throw new Error(`No ${wire} adapter for ${input.protocol}`)
      }
      return target({ ...params, ...rewritten })
    }

  if (input.wires.includes("chat")) {
    adapter.createChatCompletions = delegate(
      "chat",
      "createChatCompletions",
    ) as NonNullable<ProtocolAdapter["createChatCompletions"]>
  }
  if (input.wires.includes("messages")) {
    adapter.createMessages = delegate(
      "messages",
      "createMessages",
    ) as NonNullable<ProtocolAdapter["createMessages"]>
  }
  if (input.wires.includes("responses")) {
    adapter.createResponses = delegate(
      "responses",
      "createResponses",
    ) as NonNullable<ProtocolAdapter["createResponses"]>
  }
  if (input.wires.includes("embeddings")) {
    adapter.createEmbeddings = delegate(
      "embeddings",
      "createEmbeddings",
    ) as NonNullable<ProtocolAdapter["createEmbeddings"]>
  }
  return adapter
}
