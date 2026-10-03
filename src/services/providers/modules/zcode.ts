import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getZcodeFallbackModels } from "~/services/providers/model-catalogs/zcode"
import { fetchZcodeQuota } from "~/lib/quota/fetchers/zcode"
import type { ProviderModule } from "~/services/providers/module"
import { zcodeNativeAdapter } from "~/services/protocols/zcode-native"
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
  applyZcodeOAuthBundle,
  normalizeZcodeSite,
  startZcodeSignIn,
  zcodeSignInAndMint,
} from "~/services/oauth/zcode"

const zcodeStrategy: OAuthProviderStrategy = {
  flowType: "device",
  async start({ proxyUrl, region }) {
    const site = normalizeZcodeSite(region)
    const s = await startZcodeSignIn(site, proxyUrl ? { proxyUrl } : undefined)
    const expiresInSec = Math.max(
      Math.round((s.expiresAtMs - Date.now()) / 1000),
      1,
    )
    return {
      authUrl: s.authUrl,
      verificationUri: s.authUrl,
      deviceCode: s.flowId,
      nonce: s.pollToken,
      interval: Math.max(Math.round(s.intervalMs / 1000), 1),
      deviceExpiresIn: expiresInSec,
      responseExpiresIn: expiresInSec,
      region: site,
    }
  },
  async exchange({ flow, signal }) {
    if (!flow.deviceCode || !flow.nonce) {
      throw new Error("ZCode OAuth flow is missing its sign-in state")
    }
    const site = normalizeZcodeSite(flow.region)
    const conn = createOAuthConnection("zcode", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await zcodeSignInAndMint(
      {
        flowId: flow.deviceCode,
        authUrl: flow.authUrl ?? "",
        pollToken: flow.nonce,
        intervalMs: Math.max(flow.interval ?? 3, 1) * 1000,
        expiresAtMs:
          Date.now() + Math.max(flow.deviceExpiresIn ?? 300, 1) * 1000,
      },
      site,
      { ...flowFetchOptions(flow), signal },
    )
    applyZcodeOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const refreshAuth: OAuthRefreshFn = async () => {
  // no-op: the minted API key does not rotate
}

export function getZcodeModule(): ProviderModule {
  return {
    id: "zcode",
    descriptor: getProviderDescriptor("zcode"),
    fetchQuota: fetchZcodeQuota,
    fallbackModels: getZcodeFallbackModels,
    adapter: zcodeNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("zcode"),
    oauth: zcodeStrategy,
    refreshAuth,
  }
}
