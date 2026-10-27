/**
 * OAuth token 响应的共用管道：三件套映射、settings 字符串读取、token 表单请求。
 *
 * Antigravity / Codex / xAI 的流程各自不同，但"读 access_token、算 expiresAt、
 * POST 表单、把失败包成带 provider 名的错误"是同一段代码；差异用参数表达。
 */
import type { ProviderConnection } from "~/lib/provider-connections"
import { getConnectionSettings } from "~/lib/provider-connections"

import { oauthFetch, type OAuthFetchOptions } from "./fetch"

interface OAuthTokenPayload {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/**
 * token 响应 → bundle 的公共字段；`extras` 提供各 provider 自己的
 * id_token/email/accountId 等派生字段。
 */
export function oauthTokenBundle<
  T extends Record<string, unknown>,
  TToken extends OAuthTokenPayload,
>(
  token: TToken,
  missingAccessTokenMessage: string,
  extras: (token: TToken) => T,
): { accessToken: string; refreshToken?: string; expiresAt?: number } & T {
  if (!token.access_token) {
    throw new Error(missingAccessTokenMessage)
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt:
      token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    ...extras(token),
  }
}

/** connection settings 里的字符串项；空串视为未设置。 */
export function readSettingString(
  connection: ProviderConnection,
  key: string,
): string | undefined {
  const value = getConnectionSettings(connection)?.[key]
  return typeof value === "string" && value ? value : undefined
}

/** POST 一个 `application/x-www-form-urlencoded` 的 token 请求并解析 JSON。 */
export async function postOAuthTokenForm<T>(input: {
  url: string
  form: URLSearchParams
  options?: OAuthFetchOptions
  /** 额外请求头（如 Antigravity 的 Go 客户端 User-Agent）。 */
  headers?: Record<string, string>
  errorMessage: (status: number, body: string) => string
}): Promise<T> {
  const response = await oauthFetch(
    input.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...input.headers,
      },
      body: input.form.toString(),
    },
    input.options,
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(input.errorMessage(response.status, text))
  }
  return (await response.json()) as T
}
