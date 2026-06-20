import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import type { Account } from "~/lib/accounts"

import { getOAuthDeviceId, isOAuthAccount } from "~/lib/accounts"

export function buildKimiHeaders(
  account: Account,
  accessToken: string,
  stream?: boolean,
): Record<string, string> {
  const deviceId =
    isOAuthAccount(account) ?
      (getOAuthDeviceId(account) ?? randomUUID())
    : randomUUID()

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "KimiCLI/1.10.6",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.10.6",
    "X-Msh-Device-Name": hostname() || "unknown",
    "X-Msh-Device-Model": `${process.platform} ${process.arch}`,
    "X-Msh-Device-Id": deviceId,
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
