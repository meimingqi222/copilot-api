import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getZedFallbackModels } from "~/services/providers/model-catalogs/zed"
import { fetchZedQuota } from "~/lib/quota/fetchers/zed"
import type { ProviderModule } from "~/services/providers/module"
import { zedNativeAdapter } from "~/services/protocols/zed-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
  type OAuthRefreshFn,
} from "~/services/oauth/strategy-types"
import { upsertProviderConnection } from "~/lib/provider-connections"
import {
  applyZedOAuthBundle,
  decryptZedToken,
  fetchZedMe,
  newZedKey,
  newZedSystemId,
  ZED_CALLBACK_PORT,
  zedSignInUrl,
} from "~/services/oauth/zed"

const zedPendingKeys = new Map<
  string,
  { privateKeyPem: string; systemId: string }
>()

const zedStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const key = newZedKey()
    const systemId = newZedSystemId()
    // 用 systemId 当 state：Zed 不回我们的 state，回调里只做去重/取 key 用。
    zedPendingKeys.set(systemId, {
      privateKeyPem: key.privateKeyPem,
      systemId,
    })
    return Promise.resolve({
      authUrl: zedSignInUrl(ZED_CALLBACK_PORT, key.publicKeyB64, systemId),
      state: systemId,
    })
  },
  async exchange({ flow, code }) {
    // code = `<user_id>\u0000<encrypted access token>`（combineIntoCode）。
    const [userId, ciphertext] = (code ?? "").split("\u0000")
    if (!userId || !ciphertext) {
      throw new Error("Zed OAuth exchange requires the callback values")
    }
    const pending = zedPendingKeys.get(flow.state ?? "")
    if (!pending) {
      throw new Error("Zed OAuth flow is missing its key")
    }
    zedPendingKeys.delete(flow.state ?? "")
    const accessToken = decryptZedToken(pending.privateKeyPem, ciphertext)
    const conn = createOAuthConnection("zed", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const me = await fetchZedMe(
      userId,
      accessToken,
      pending.systemId,
      flowFetchOptions(flow),
    )
    applyZedOAuthBundle(conn, {
      userId,
      accessToken,
      systemId: pending.systemId,
      org: me.org,
      login: me.login,
      name: me.name,
      plan: me.plan,
    })
    upsertProviderConnection(conn)
    return conn
  },
}

const refreshAuth: OAuthRefreshFn = async () => {
  // no-op: the Zed account token does not rotate
}

export function getZedModule(): ProviderModule {
  return {
    id: "zed",
    descriptor: getProviderDescriptor("zed"),
    fetchQuota: fetchZedQuota,
    fallbackModels: getZedFallbackModels,
    adapter: zedNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("zed"),
    oauth: zedStrategy,
    refreshAuth,
  }
}
