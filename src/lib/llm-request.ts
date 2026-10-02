export function isLlmRequest(request: {
  method?: string
  path?: string
}): boolean {
  const { method, path } = request
  if (!path) return false
  if (method === "WS") return path === "/responses" || path === "/v1/responses"
  if (method !== undefined && method !== "POST") return false
  return (
    path === "/chat/completions"
    || path === "/v1/chat/completions"
    || path === "/v1/messages"
    || path === "/responses"
    || path === "/v1/responses"
    || path === "/responses/compact"
    || path === "/v1/responses/compact"
    || /^\/v1beta\/models\/.+:(?:generateContent|streamGenerateContent)$/.test(
      path,
    )
  )
}
