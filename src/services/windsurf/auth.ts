import type { Account } from "~/lib/accounts"

import { getWindsurfApiKey, setWindsurfJwt } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"

import {
  buildWindsurfClientMetadata,
  wrapWindsurfMetadataMessage,
} from "./metadata"
import { extractStrings } from "./protobuf"

export async function fetchWindsurfJwt(
  account: Account,
  settings: {
    apiKey?: string
    baseUrl: string
    appVersion: string
    lsVersion: string
    clientName: string
  },
): Promise<string> {
  const apiKey = settings.apiKey ?? getWindsurfApiKey(account)
  if (!apiKey) {
    throw new Error(`Windsurf API key missing for account "${account.label}"`)
  }

  const response = await fetch(
    `${settings.baseUrl}/exa.auth_pb.AuthService/GetUserJwt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "User-Agent": "connect-go/1.18.1 (go1.26.1)",
        "Accept-Encoding": "gzip",
      },
      body: wrapWindsurfMetadataMessage(
        buildWindsurfClientMetadata({
          apiKey,
          settings,
        }),
      ),
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to fetch Windsurf JWT",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  const strings = extractStrings(new Uint8Array(await response.arrayBuffer()))
  const jwt = strings.find(
    (value) => value.startsWith("eyJ") && value.includes("."),
  )
  if (!jwt) {
    throw new Error("Failed to extract Windsurf JWT from auth response")
  }

  setWindsurfJwt(account, jwt)
  return jwt
}
