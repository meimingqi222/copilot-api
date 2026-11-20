import type { ProviderId } from "~/lib/provider-config"

import { astudioWebLogin } from "./providers/astudio"
import { dumateWebLogin } from "./providers/dumate"
import { inkstoneWebLogin } from "./providers/inkstone"
import { wpsLingxiWebLogin } from "./providers/wps-lingxi"
import type { WebLoginProvider } from "./types"

export type { WebLoginBrowser, WebLoginCookie } from "./types"

/**
 * 支持「内置网页扫码登录」的提供方。
 *
 * 入选条件：厂商只有网页会话（Cookie）这一种身份，且登录页默认给出二维码。
 * 已有标准 OAuth 的（claude / codex / minimax / raccoon / codearts / meoo …）
 * 不在这里——它们走 `~/services/oauth` 的授权码/设备码流程。
 */
export const WEB_LOGIN_PROVIDERS: ReadonlyArray<WebLoginProvider> = [
  astudioWebLogin,
  dumateWebLogin,
  inkstoneWebLogin,
  wpsLingxiWebLogin,
]

export function getWebLoginProvider(
  provider: string,
): WebLoginProvider | undefined {
  return WEB_LOGIN_PROVIDERS.find((entry) => entry.provider === provider)
}

export function isWebLoginProvider(provider: string): provider is ProviderId {
  return getWebLoginProvider(provider) !== undefined
}
