import consola from "consola"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  const FATAL_ERRORS = new Set([
    "access_denied",
    "expired_token",
    "unsupported_grant_type",
    "incorrect_client_credentials",
    "incorrect_device_code",
  ])

  while (true) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      const errorText = await response.text()
      consola.error("Failed to poll access token:", errorText)
      await sleep(sleepDuration)
      continue
    }

    const json = (await response.json()) as AccessTokenResponse & {
      error?: string
    }
    consola.debug("Polling access token response:", json)

    if (json.error) {
      if (FATAL_ERRORS.has(json.error)) {
        throw new Error(`GitHub device auth failed: ${json.error}`)
      }
      await sleep(sleepDuration)
      continue
    }

    if (json.access_token) {
      return json.access_token
    }

    await sleep(sleepDuration)
  }
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
