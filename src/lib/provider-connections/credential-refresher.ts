/**
 * 凭据刷新器接口。
 *
 * 对 Copilot/OAuth 等需要定期刷新 token 的 provider,
 * credential.value 代表"当前生效 token",credential.context 代表"刷新所需的源材料"。
 *
 * 语义约定:
 * - credential.value = 当前用于发请求的 token(Bearer ${credential.value})
 * - credential.context = 刷新所需的源材料(githubToken / refreshToken 等)
 * - buildBaseHeaders 始终使用 credential.value,无需感知 refresher
 */
import type { ApiCredential } from "./types"

export type CredentialRefresherType =
  | "copilot-token"
  | "oauth-token"
  | "windsurf-jwt"
  | "static"

export interface CredentialRefresher {
  type: CredentialRefresherType

  /** 刷新 credential.value,更新 context 中的过期时间。 */
  refresh(credential: ApiCredential): Promise<void>

  /** 判断是否需要刷新(基于 context 中的 expiry)。 */
  needsRefresh(credential: ApiCredential): boolean

  /** 安排下次自动刷新。 */
  scheduleNextRefresh(credential: ApiCredential): void
}

const registry = new Map<CredentialRefresherType, CredentialRefresher>()

export function registerCredentialRefresher(
  refresher: CredentialRefresher,
): void {
  registry.set(refresher.type, refresher)
}

export function getCredentialRefresher(
  type: CredentialRefresherType,
): CredentialRefresher | undefined {
  return registry.get(type)
}
