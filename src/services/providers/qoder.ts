/**
 * Qoder Provider Runtime。
 *
 * 复用 `createOAuthProviderRuntime` 的配额刷新 / 认证刷新 / 能力判定
 * （qoder / qoder-cn 都在 `OAUTH_PROVIDER_IDS` 里，OAuth 刷新调度直接可用），
 * 只覆盖**模型发现**：Qoder 没有静态模型表，模型只能由登录后的 `model/list`
 * 实时发现，所以必须走 adapter 的 `discoverModels`（codebuddy 的先例），
 * 而不是 `discoverOAuthModelsForConnection` 的 switch 兜底目录。
 *
 * 两个站点（qoder / qoder-cn）共用同一套逻辑，只是 provider id 不同，
 * 所以 runtime 按 provider 参数化生成。
 */

import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"
import { getMutableProviderConnection } from "~/lib/provider-connections"
import { asRecord } from "~/lib/json-shape"
import { recoverQoderAuthentication } from "~/services/oauth/qoder"
import { parseQoderModelList } from "~/services/qoder/models"
import { getProtocolAdapter } from "~/services/protocols"

import { createOAuthProviderRuntime } from "./oauth"
import type { ProviderRuntime } from "./runtime"

const stillFree = new WeakMap<ProviderConnection, string>()

/** A disabled paid catalog can be a stale sign-in, not necessarily exhausted credits. */
export function qoderListingHasOnlyFreeModels(raw: unknown): boolean {
  const listing = asRecord(raw)
  const scene = listing?.app ?? listing?.chat
  if (!Array.isArray(scene)) return false
  let paidDisabled = false
  for (const item of scene) {
    const entry = asRecord(item)
    if (!entry) continue
    const parsed = parseQoderModelList({ app: [{ ...entry, enable: true }] })[0]
    if (!parsed || parsed.free) continue
    if (entry.enable === true) return false
    paidDisabled = true
  }
  return paidDisabled
}

/** Call around the raw model-list read, before disabled entries are filtered.
 * The callback must sign with the supplied current connection on every call.
 */
export async function withQoderModelAuthRecovery(
  connection: ProviderConnection,
  fetchListing: (current: ProviderConnection) => Promise<unknown>,
): Promise<unknown> {
  const live = getMutableProviderConnection(connection.id) ?? connection
  const token = live.credentials[0]?.value ?? ""
  let listing = await fetchListing(live)
  if (!qoderListingHasOnlyFreeModels(listing) || stillFree.get(live) === token)
    return listing
  if (await recoverQoderAuthentication(live, token)) {
    listing = await fetchListing(live)
    if (qoderListingHasOnlyFreeModels(listing))
      stillFree.set(live, live.credentials[0]?.value ?? "")
  }
  return listing
}

/** 按 provider id 生成 runtime（"qoder" 或 "qoder-cn"）。 */
export function qoderProviderRuntimeFor(
  providerId: OAuthProviderId,
): ProviderRuntime {
  const base = createOAuthProviderRuntime(providerId)
  return {
    ...base,
    async refreshModels(connection) {
      const adapter = getProtocolAdapter("qoder-native")
      const credential = connection.credentials[0]
      if (adapter?.discoverModels && credential) {
        try {
          const models = await adapter.discoverModels({
            connection,
            credential,
          })
          if (models.length > 0) return models
        } catch {
          // 发现失败时退到 catalog（兜底静态表）。
        }
      }
      return this.getFallbackModels?.(connection) ?? []
    },
  }
}
