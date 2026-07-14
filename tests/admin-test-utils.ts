import { ADMIN_SESSION_COOKIE } from "~/lib/request-auth"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"

export const TEST_ADMIN_SESSION_TOKEN = "test-admin-session-token"

export function setupAdminAuth(): void {
  state.adminSessionToken = TEST_ADMIN_SESSION_TOKEN
  state.adminSessionExpiresAt = Date.now() + 60_000
}

export function clearAdminAuth(): void {
  state.adminSessionToken = undefined
  state.adminSessionExpiresAt = undefined
}

export function clearAdminPasswordConfig(): void {
  state.adminPassword = undefined
  state.legacyApiKey = undefined
  statsStore.deleteConfig("admin_password_hash")
}

export function adminHeaders(
  init?: ConstructorParameters<typeof Headers>[0],
): Headers {
  const headers = new Headers(init)
  headers.set("cookie", `${ADMIN_SESSION_COOKIE}=${TEST_ADMIN_SESSION_TOKEN}`)
  return headers
}

export function adminRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: adminHeaders(init?.headers),
  })
}

export async function adminFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { server } = await import("~/server")
  return server.fetch(adminRequest(url, init))
}
