import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"

/**
 * 取 xAI 连接的 OAuth access token（必要时先刷新）；拿不到时抛出带连接名的
 * 错误，四个调用方（responses / compact / images / videos）共用同一句提示。
 */
export async function requireXaiAccessToken(
  connection: ProviderConnection,
  credential: ApiCredential,
): Promise<string> {
  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `xAI access token missing for connection "${connection.name}"`,
    )
  }
  return accessToken
}
