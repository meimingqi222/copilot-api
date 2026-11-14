import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { logger } from "~/lib/logger"
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

/**
 * Send an xAI request, retrying once with a forced token refresh when the
 * upstream answers 403 bad-credentials (an invalidated OAuth access token).
 * `send` builds the headers/body for a given token; shared by the responses
 * and compact paths so the refresh-and-retry rule lives in one place.
 */
export async function fetchXaiWithCredentialRetry(opts: {
  connection: ProviderConnection
  credential: ApiCredential
  accessToken: string
  send: (accessToken: string) => Promise<Response>
}): Promise<Response> {
  const { connection, credential, send } = opts
  let currentAccessToken = opts.accessToken
  let response = await send(currentAccessToken)

  if (response.status === 403) {
    const errorBody = await response
      .clone()
      .text()
      .catch(() => "")
    if (
      /unauthenticated:bad-credentials|could not be validated/i.test(errorBody)
    ) {
      logger.warn(
        `xAI returned 403 bad-credentials for connection "${connection.name}". Forcing token refresh...`,
      )
      const refreshedToken = await ensureOAuthConnectionAccessToken(
        connection,
        credential,
        {
          forceRefresh: true,
          failedAccessToken: currentAccessToken,
        },
      )
      if (refreshedToken && refreshedToken !== currentAccessToken) {
        currentAccessToken = refreshedToken
        response = await send(currentAccessToken)
      }
    }
  }

  return response
}
