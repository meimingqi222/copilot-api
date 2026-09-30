/**
 * Gemini (Code Assist) 配额拉取（最小实现）。
 *
 * Code Assist 没有公开的用量窗口端点；这里只报账号的 tier（来自
 * loadCodeAssist），不编造百分比窗口。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import {
  GEMINI_CODE_ASSIST_BASE,
  geminiUserAgent,
} from "~/services/oauth/gemini"

export async function fetchGeminiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "gemini") {
    throw new Error("fetchGeminiQuota requires a Gemini connection")
  }
  const token = connection.credentials[0]?.value
  if (!token) {
    throw new Error(
      "Gemini usage is unavailable: the saved sign-in carries no access token — sign in again",
    )
  }
  const response = await fetch(
    `${GEMINI_CODE_ASSIST_BASE}/v1internal:loadCodeAssist`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": geminiUserAgent(),
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
      signal,
    },
  )
  if (!response.ok) {
    throw new Error(`Gemini usage request failed (HTTP ${response.status})`)
  }
  const body = (await response.json()) as {
    currentTier?: { name?: string; id?: string }
    paidTier?: { name?: string; id?: string }
  }
  const plan =
    body.paidTier?.name
    ?? body.currentTier?.name
    ?? body.paidTier?.id
    ?? body.currentTier?.id
  return {
    fetchedAt: Date.now(),
    provider: "gemini",
    unlimited: true,
    details: { gemini: { host: GEMINI_CODE_ASSIST_BASE, plan } },
  }
}
