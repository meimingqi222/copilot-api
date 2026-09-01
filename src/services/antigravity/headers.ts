import { buildAntigravityHubUserAgent } from "~/services/antigravity/version"

export function buildAntigravityHeaders(
  accessToken: string,
  stream?: boolean,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "*/*",
    "User-Agent": buildAntigravityHubUserAgent(),
  }
}
