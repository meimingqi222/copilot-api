/**
 * 凭据刷新策略名，持久化在 connection / credential 上。
 *
 * 真正的刷新由各 provider 的 connection-native 实现与其调度器完成
 * （refreshCopilotTokenForConnection / refreshOAuthConnectionToken /
 * scheduleOAuthRefreshForConnection 等），不存在按类型分派的运行时注册表。
 * 这里只保留持久化的策略标识，供旧文件解析与展示使用。
 */
export type CredentialRefresherType =
  | "copilot-token"
  | "oauth-token"
  | "windsurf-jwt"
  | "codebuddy-token"
  | "lobsterai-token"
  | "static"
