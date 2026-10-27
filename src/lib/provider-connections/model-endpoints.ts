import type { ModelEndpoint } from "./types"

/**
 * 上游 `/models` 的 `supported_endpoints`（路径或裸名）→ 连接用的
 * `ModelEndpoint`。
 *
 * Copilot、account 模型导入和 AccountModel→mapping 三条路曾经各抄一份；
 * 认不出任何端点时按 `chat` 处理（旧行为），避免模型变得不可路由。
 */
export function endpointsFromSupported(
  supported: ReadonlyArray<string>,
): Array<ModelEndpoint> {
  const endpoints: Array<ModelEndpoint> = []
  for (const endpoint of supported) {
    if (endpoint.includes("chat/completions")) endpoints.push("chat")
    else if (endpoint.includes("messages")) endpoints.push("messages")
    else if (endpoint.includes("responses")) endpoints.push("responses")
    else if (endpoint === "gemini") endpoints.push("gemini")
    else if (endpoint.includes("embeddings")) endpoints.push("embeddings")
    else if (endpoint.includes("images")) endpoints.push("images")
    else if (endpoint.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")
  return endpoints
}
