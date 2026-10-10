/**
 * 无密钥连接的匿名凭据。
 *
 * 免费车道(Kilo 公共网关、OpenCode Zen 免费层)不挂任何 credential:它们要么
 * 完全匿名,要么用连接 `headers` 里的公共池凭据。但路由展平、模型发现都以
 * 「至少一个凭据」为前提,空数组等于「连接不可路由 / 无可用凭据」。
 *
 * 这里按 connection 对象记忆一个合成凭据(id 取 connection.id,与通配 target 的
 * `credentials[0]?.id ?? connection.id` 约定一致,统计侧 usageAccountIds 也已把
 * connection id 算进去)。用 WeakMap 而不是每次新建,是为了让 429 打上的
 * cooldown / 模型级休息在同一进程内可累积——否则每个请求都拿到一张新白纸,
 * 限流退避就废了。进程重启后冷却状态丢失,这是免费车道可接受的代价。
 */

import type { ApiCredential, ProviderConnection } from "./types"

const ANONYMOUS_CREDENTIALS = new WeakMap<ProviderConnection, ApiCredential>()

/** 该连接的合成匿名凭据(同一 connection 对象始终返回同一个实例)。 */
export function anonymousCredentialFor(
  connection: ProviderConnection,
): ApiCredential {
  const cached = ANONYMOUS_CREDENTIALS.get(connection)
  if (cached) return cached
  const credential: ApiCredential = {
    id: connection.id,
    authMode: "bearer",
    // 空值:buildBaseHeaders 见到空 value 就不写 Authorization——
    // Kilo 对带头部的匿名请求直接 401 INVALID_TOKEN。
    value: "",
    enabled: true,
    status: "ready",
    createdAt: connection.createdAt,
  }
  ANONYMOUS_CREDENTIALS.set(connection, credential)
  return credential
}

/**
 * 连接实际参与调度的凭据列表。
 *
 * - 字段整个缺失(脏数据 / 旧 schema)→ `[]`,调用方按「不可路由」处理,
 *   坏记录不因为免费车道的新能力突然变成可调度;
 * - 显式空数组 → 刻意的无密钥连接,补一个匿名凭据;
 * - 非空 → 原样返回。
 */
export function effectiveCredentials(
  connection: ProviderConnection,
): Array<ApiCredential> {
  const credentials = (connection as { credentials?: unknown }).credentials
  if (!Array.isArray(credentials)) return []
  if (credentials.length > 0) return credentials as Array<ApiCredential>
  return [anonymousCredentialFor(connection)]
}

/**
 * 连接是否至少有一个已启用的凭据。
 *
 * 无密钥连接(免费车道,`credentials` 为空数组)按合成匿名凭据计——它们照常参与
 * 路由、模型照常进 `/v1/models`。字段整个缺失(脏数据 / 旧 schema)时,
 * `effectiveCredentials` 返回 `[]`,仍按「无凭据」处理。
 *
 * 列举 / 可用性过滤一律用本函数,而不是直接读 `connection.credentials`:
 * 后者会把免密连接误判成「无凭据」而整条漏掉。
 */
export function hasEnabledCredential(connection: ProviderConnection): boolean {
  return effectiveCredentials(connection).some(
    (credential) => credential.enabled,
  )
}

/**
 * 读路径按 id 解析凭据:免密连接用合成匿名凭据兜底。
 *
 * 路由 target 上无密钥连接的 `credentialId` 取 `credentials[0]?.id ??
 * connection.id`(见 `buildRouteTargets`),而匿名凭据的 id 正是 connection.id。
 * 但那份凭据只存在于 `effectiveCredentials` 里,原始 `connection.credentials`
 * 是空数组——若读路径直接 `.find` 就会解析失败(准入层表现为 503
 * "Route target resolution failed")。变更 / admin 路径要操作真实凭据,仍用
 * `findCredential`。
 */
export function findEffectiveCredential(
  connection: ProviderConnection,
  credentialId: string,
): ApiCredential | undefined {
  return effectiveCredentials(connection).find((c) => c.id === credentialId)
}
