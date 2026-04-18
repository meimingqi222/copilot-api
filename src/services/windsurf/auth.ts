import type { Account } from "~/lib/accounts"

import { getWindsurfApiKey, setWindsurfJwt } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"

import { ProtobufEncoder, extractStrings } from "./protobuf"

function buildAuthMetadata(opts: {
  apiKey: string
  appVersion: string
  lsVersion: string
  clientName: string
}): Uint8Array {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, opts.clientName)
  metadata.writeString(2, opts.appVersion)
  metadata.writeString(3, opts.apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(
    5,
    JSON.stringify({
      Os: process.platform === "win32" ? "windows" : process.platform,
      Arch: process.arch,
      Version: process.version,
      ProductName: process.platform,
    }),
  )
  metadata.writeString(7, opts.lsVersion)
  metadata.writeString(12, opts.clientName)
  metadata.writeBytes(30, Uint8Array.from([0, 1]))

  const outer = new ProtobufEncoder()
  outer.writeMessage(1, metadata)
  return outer.toUint8Array()
}

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
      body: buildAuthMetadata({
        apiKey,
        appVersion: settings.appVersion,
        lsVersion: settings.lsVersion,
        clientName: settings.clientName,
      }),
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
