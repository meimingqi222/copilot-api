/**
 * Zed 配额拉取（最小实现）。
 *
 * Zed 没有公开的用量窗口端点；这里只读 `GET /client/users/me` 里的计划，
 * 作为账号信息展示，不编造百分比窗口。
 */

import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { ZED_CLOUD, zedUserAgent } from "~/services/oauth/zed"

export async function fetchZedQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  if (getConnectionProvider(connection) !== "zed") {
    throw new Error("fetchZedQuota requires a Zed connection")
  }
  const uid = connection.credentials[0]?.context?.zedUserId
  const token = connection.credentials[0]?.value
  const systemId = connection.credentials[0]?.context?.systemId
  if (typeof uid !== "string" || !token) {
    throw new Error(
      "Zed usage is unavailable: the saved sign-in is incomplete — sign in again",
    )
  }
  const response = await fetchWithConnectionProxy(
    connection,
    `${ZED_CLOUD}/client/users/me`,
    {
      method: "GET",
      headers: {
        authorization: `${uid} ${token}`,
        accept: "application/json",
        "user-agent": zedUserAgent(),
        ...(typeof systemId === "string" && systemId ?
          { "x-zed-system-id": systemId }
        : {}),
      },
      signal,
    },
  )
  if (!response.ok) {
    throw new Error(`Zed usage request failed (HTTP ${response.status})`)
  }
  const body = (await response.json()) as Record<string, unknown>
  const planObj = (body.plan ?? {}) as Record<string, unknown>
  const plan = typeof planObj.plan_v3 === "string" ? planObj.plan_v3 : undefined
  return {
    fetchedAt: Date.now(),
    provider: "zed",
    unlimited: true,
    details: { zed: { host: ZED_CLOUD, plan } },
  }
}
