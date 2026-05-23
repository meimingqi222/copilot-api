import consola from "consola"

import { HTTPError } from "~/lib/error"
import {
  classifyUpstreamError,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  DEFAULTS,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"

export function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "")
  const trimmedPath = path.startsWith("/") ? path : `/${path}`
  return `${trimmedBase}${trimmedPath}`
}

export function buildBaseHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...connection.headers,
  }

  if (credential.authMode === "bearer") {
    headers["Authorization"] = `Bearer ${credential.value}`
  } else {
    const headerName = credential.headerName ?? "Authorization"
    headers[headerName] = credential.value
  }
  return headers
}

export async function handleUpstreamFailure(
  response: Response,
  credential: ApiCredential,
  contextMessage: string,
  adapterName: string,
): Promise<never> {
  const body = await response
    .clone()
    .text()
    .catch(() => "")
  const classified = classifyUpstreamError({
    status: response.status,
    retryAfterHeader: response.headers.get("retry-after"),
    body,
  })

  switch (classified.kind) {
    case "rate_limited": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs,
        reason: `HTTP ${response.status}`,
      })
      break
    }
    case "auth_error": {
      markCredentialAuthError(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      )
      break
    }
    case "quota_exhausted": {
      markCredentialQuotaExhausted(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      )
      break
    }
    case "server_error": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs ?? DEFAULTS.COOLDOWN_5XX_MS,
        reason: `HTTP ${response.status}`,
      })
      break
    }
    default: {
      break
    }
  }

  await persistProviderConnections().catch((err: unknown) => {
    consola.warn(
      `[${adapterName}] failed to persist credential status:`,
      (err as Error).message,
    )
  })
  throw new HTTPError(contextMessage, response, body)
}
