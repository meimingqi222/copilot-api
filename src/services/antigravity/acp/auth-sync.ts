/**
 * Antigravity ACP 多账号目录隔离与 OAuth 凭证同步。
 *
 * 每个 ProviderConnection 拥有独立的 `--gemini-dir`，并在启动或复用前
 * 将当前连接的有效 OAuth 凭证写入 `<geminiDir>/jetski-standalone-oauth-token`，
 * 确保多账号完全隔离且复用现有的自动刷新体系。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import {
  getCredentialContextString,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"

const DEFAULT_EXPIRES_IN_SECONDS = 3599

function sanitizeSegment(value: string | undefined): string {
  const cleaned = (value ?? "default").replace(/[^a-zA-Z0-9._-]/g, "_")
  return cleaned || "default"
}

function antigravityAcpRootDir(): string {
  return path.join(PATHS.APP_DIR, "antigravity-acp")
}

function antigravityAcpAccountDir(connectionId: string | undefined): string {
  return path.join(
    antigravityAcpRootDir(),
    "accounts",
    sanitizeSegment(connectionId),
  )
}

function antigravityAcpWorkspaceDir(): string {
  return path.join(antigravityAcpRootDir(), "workspace")
}

interface JetskiOAuthFile {
  token: {
    access_token: string
    token_type: string
    refresh_token?: string
    expiry: string
    expires_in: number
  }
  auth_method: string
  id_token_email?: string
}

export async function syncAntigravityAcpCredentials(
  connection: ProviderConnection,
  credential: ApiCredential,
): Promise<{ geminiDir: string; workspaceDir: string }> {
  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Antigravity access token missing for connection "${connection.name}"`,
    )
  }

  const geminiDir = antigravityAcpAccountDir(connection.id)
  const workspaceDir = antigravityAcpWorkspaceDir()
  await mkdir(geminiDir, { recursive: true, mode: 0o700 })
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 })

  const rawRefresh = credential.context?.refreshToken
  const refreshToken =
    typeof rawRefresh === "string" ? rawRefresh.trim() : undefined
  const rawExpiresAt = credential.context?.expiresAt
  const expiresAtMs =
    typeof rawExpiresAt === "number" && Number.isFinite(rawExpiresAt) ?
      rawExpiresAt
    : Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000
  const expiresIn = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000))
  const email =
    getCredentialContextString(connection, "email")
    ?? connection.metadata?.accountEmail
    ?? undefined

  const payload: JetskiOAuthFile = {
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expiry: new Date(expiresAtMs).toISOString(),
      expires_in: expiresIn,
    },
    auth_method: "oauth-personal",
    ...(typeof email === "string" && email.trim() ?
      { id_token_email: email.trim() }
    : {}),
  }

  const tokenFilePath = path.join(geminiDir, "jetski-standalone-oauth-token")
  await writeFile(tokenFilePath, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  })

  return { geminiDir, workspaceDir }
}
