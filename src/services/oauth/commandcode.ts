/**
 * Command Code Plan OAuth：CLI 的浏览器登录。
 *
 * 流程（Studio 把新 key POST 到 loopback 回调，不是重定向带 code）：
 *
 *   打开  https://commandcode.ai/studio/auth/cli?callback=http://127.0.0.1:<port>/callback&state=<state>&mode=redirect
 *   回调  POST http://127.0.0.1:<port>/callback   body {apiKey,state,userId,userName,keyName}
 *   身份  GET  https://api.commandcode.ai/alpha/whoami   Authorization: Bearer <key>
 *
 * 计划 API（Provider API，key 同时进 Authorization: Bearer + x-api-key）：
 *   Chat / Responses : https://api.commandcode.ai/provider/v1
 *   Anthropic        : https://api.commandcode.ai/provider/v1
 * 用量：/alpha/billing/credits + /alpha/billing/subscriptions。
 *
 * key 是长期凭证，不轮换，因此没有 refresh。
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"

import { applyOAuthBundleToCredential } from "./apply-bundle"
import { oauthFetch, type OAuthFetchOptions } from "./fetch"

export const COMMANDCODE_CALLBACK_PORT = 59654
export const COMMANDCODE_CALLBACK_PATH = "/callback"

export const COMMANDCODE_STUDIO = "https://commandcode.ai"
export const COMMANDCODE_API = "https://api.commandcode.ai"
export const COMMANDCODE_PROVIDER_BASE = `${COMMANDCODE_API}/provider/v1`

const COMMANDCODE_CALLBACK_URI = `http://127.0.0.1:${COMMANDCODE_CALLBACK_PORT}${COMMANDCODE_CALLBACK_PATH}`

interface CommandCodeBundle {
  apiKey: string
  userName?: string
  email?: string
  userId?: string
  plan?: string
}

/** 授权页 URL：Studio 会把它铸的 key POST 回我们的回调。 */
export function buildCommandCodeAuthUrl(state: string): string {
  const query = new URLSearchParams({
    callback: COMMANDCODE_CALLBACK_URI,
    state,
    mode: "redirect",
  })
  return `${COMMANDCODE_STUDIO}/studio/auth/cli?${query.toString()}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

async function commandCodeGet(
  path: string,
  apiKey: string,
  options?: OAuthFetchOptions,
): Promise<unknown> {
  const response = await oauthFetch(
    `${COMMANDCODE_API}${path}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        accept: "application/json",
      },
    },
    options,
  )
  if (!response.ok) {
    throw new HTTPError(
      `Command Code request failed (${response.status})`,
      new Response(null, { status: response.status }),
      "",
    )
  }
  return response.json()
}

/** whoami：拿到账号名（key 刚铸出时上游可能 500，调用方自行重试）。 */
async function fetchCommandCodeWhoami(
  apiKey: string,
  options?: OAuthFetchOptions,
): Promise<{ userName?: string; email?: string; userId?: string }> {
  const data = asRecord(await commandCodeGet("/alpha/whoami", apiKey, options))
  const user = asRecord(data?.user)
  return {
    userName: str(user?.userName) || str(user?.name) || undefined,
    email: str(user?.email) || undefined,
    userId: str(user?.id) || undefined,
  }
}

/** 计划名（Pro/GOAT/Max/Ultra/Go），best-effort。 */
async function fetchCommandCodePlan(
  apiKey: string,
  options?: OAuthFetchOptions,
): Promise<string | undefined> {
  try {
    const data = await commandCodeGet(
      "/alpha/billing/subscriptions",
      apiKey,
      options,
    )
    const list = Array.isArray(data) ? data : [data]
    for (const item of list) {
      const sub = asRecord(item)
      const name = str(sub?.plan) || str(sub?.name) || str(sub?.tier)
      if (name) return name
    }
  } catch {
    // 计划名只是展示，失败不影响登录。
  }
  return undefined
}

/** 把 Studio POST 回来的 key 变成完整 bundle（含 whoami 身份）。 */
export async function finalizeCommandCodeBundle(
  apiKey: string,
  options?: OAuthFetchOptions,
): Promise<CommandCodeBundle> {
  const bundle: CommandCodeBundle = { apiKey }
  // whoami 对刚铸出的 key 可能短暂 500：重试几次再放弃（key 仍然可用）。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const who = await fetchCommandCodeWhoami(apiKey, options)
      if (who.userName || who.email || who.userId) {
        bundle.userName = who.userName
        bundle.email = who.email
        bundle.userId = who.userId
        break
      }
    } catch {
      // retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000))
  }
  bundle.plan = await fetchCommandCodePlan(apiKey, options)
  return bundle
}

/** 落库：credential.value = key；身份进 context。 */
export function applyCommandCodeOAuthBundle(
  connection: ProviderConnection,
  bundle: CommandCodeBundle,
): void {
  applyOAuthBundleToCredential(
    connection,
    { accessToken: bundle.apiKey },
    {
      accountId: bundle.userId,
      email: bundle.email ?? bundle.userName,
    },
  )
}
