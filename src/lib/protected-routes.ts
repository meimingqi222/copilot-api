export type ProtectedRouteKind = "reasoning" | "token"

const REASONING_PATHS = new Set([
  "/chat/completions",
  "/responses",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
])

export function getProtectedRouteKind(path: string): ProtectedRouteKind | null {
  if (path === "/token") {
    return "token"
  }
  if (REASONING_PATHS.has(path)) {
    return "reasoning"
  }
  return null
}

export function isProtectedRoute(path: string): boolean {
  return getProtectedRouteKind(path) !== null
}
