import { buildAntigravityUserAgent } from "~/services/oauth/antigravity"

export function buildAntigravityHeaders(
  accessToken: string,
  stream?: boolean,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "*/*",
    "User-Agent": buildAntigravityUserAgent(),
    Connection: "close",
  }
}
