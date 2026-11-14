/**
 * Antigravity ACP 多账号目录隔离与 OAuth 凭证同步。
 *
 * 每个 ProviderConnection 拥有独立的 `--gemini-dir`，并在启动或复用前
 * 将当前连接的有效 OAuth 凭证写入 agy CLI 真实读取的位置：
 * `<geminiDir>/antigravity-cli/antigravity-oauth-token`。
 *
 * 注意（agy 1.5.x 实测）：
 * - 文件名是 `antigravity-oauth-token`（由 `antigravity-%s` 拼出），
 *   `jetski-standalone-oauth-token` 是旧布局，ACP/CLI 都不会打开它。
 * - `auth_method` 必须是 `consumer`（个人账号）等 agy 内部枚举值，
 *   写成 ACP 的 methodId（`oauth-personal`）会被判为 unknown auth method。
 * - `id_token` 可选：缺失时 agy 记日志 `email=` 为空，但仍能认证。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"

const DEFAULT_EXPIRES_IN_SECONDS = 3599

/** agy CLI 在 `--app-data-dir` 下使用的子目录名（默认 `antigravity-cli`）。 */
const AGY_APP_DATA_DIR = "antigravity-cli"
/** agy 读取的凭据文件名，来自二进制里的 `antigravity-%s` 模板。 */
const AGY_TOKEN_FILE = "antigravity-oauth-token"

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

interface AgyOAuthFile {
  token: {
    access_token: string
    token_type: string
    refresh_token?: string
    expiry: string
    expires_in: number
  }
  auth_method: string
  id_token?: string
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
  const appDataDir = path.join(geminiDir, AGY_APP_DATA_DIR)
  await mkdir(appDataDir, { recursive: true, mode: 0o700 })
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

  const rawIdToken = credential.context?.idToken
  const idToken =
    typeof rawIdToken === "string" && rawIdToken.trim() ?
      rawIdToken.trim()
    : undefined

  const payload: AgyOAuthFile = {
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expiry: new Date(expiresAtMs).toISOString(),
      expires_in: expiresIn,
    },
    // agy 的 auth_method 枚举：个人账号为 `consumer`。
    auth_method: "consumer",
    ...(idToken ? { id_token: idToken } : {}),
  }

  const tokenFilePath = path.join(appDataDir, AGY_TOKEN_FILE)
  await writeFile(tokenFilePath, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  })

  return { geminiDir, workspaceDir }
}
