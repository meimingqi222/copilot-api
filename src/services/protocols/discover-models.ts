/**
 * compatible adapter 共用的模型发现骨架：解析 endpoint → 带连接代理/头请求 →
 * 失败交给 handleUpstreamFailure。各 adapter 只负责把响应解析成 ModelMapping。
 */
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { connectionFetchInit, handleUpstreamFailure, joinUrl } from "./shared"

export async function discoverJsonModels<T>(input: {
  connection: ProviderConnection
  credential: ApiCredential
  signal?: AbortSignal
  headers: Record<string, string>
  /** 报错时用的 provider 名（如 "openai-compatible"）。 */
  providerLabel: string
  /** 未配置自定义 endpoint 时的相对路径，默认 `/models`。 */
  defaultEndpoint?: string
}): Promise<T> {
  const endpoint =
    input.connection.modelDiscovery?.endpoint
    ?? input.defaultEndpoint
    ?? "/models"
  const url =
    /^https?:/i.test(endpoint) ? endpoint : (
      joinUrl(input.connection.baseUrl, endpoint)
    )
  const response = await fetch(
    url,
    connectionFetchInit(input.connection, {
      headers: input.headers,
      signal: input.signal,
    }),
  )
  if (!response.ok) {
    await handleUpstreamFailure(
      response,
      input.credential,
      "Failed to discover models",
      input.providerLabel,
    )
  }
  return (await response.json()) as T
}
