/**
 * compatible adapter 共用的模型发现骨架：解析 endpoint → 带连接代理/头请求 →
 * 失败交给 handleUpstreamFailure。各 adapter 只负责把响应解析成 ModelMapping。
 */
import type {
  ApiCredential,
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import { connectionFetchInit, handleUpstreamFailure, joinUrl } from "./shared"

/** 把 OpenAI 风格的 `{ id, owned_by }` 列表投影成 ModelMapping。 */
export function discoveredModelMappings(
  models: ReadonlyArray<{ id?: unknown; owned_by?: unknown }>,
  endpointsForId: (id: string) => Array<ModelMapping["endpoints"][number]>,
): Array<ModelMapping> {
  return models.flatMap((model) => {
    if (typeof model.id !== "string") return []
    return [
      {
        publicId: model.id,
        upstreamId: model.id,
        ...(typeof model.owned_by === "string" ?
          { vendor: model.owned_by }
        : {}),
        endpoints: endpointsForId(model.id),
        enabled: true,
        pickerEnabled: true,
      },
    ]
  })
}

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
