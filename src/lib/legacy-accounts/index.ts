/**
 * Legacy Accounts 边界。
 *
 * Phase 5:Account 兼容代码的隔离边界。外部代码应使用 ProviderConnection,
 * 仅在迁移/兼容路径中通过此 barrel 访问 legacy Account 类型/逻辑。
 */
export * from "./account-availability"
export * from "./account-selection"
export * from "./accounts"
export * from "./boot-migration"
export * from "./file-store"
export * from "./legacy-types"
export * from "./persistence"
export * from "./record-migrator"
export * from "./serialize"
export * from "./to-connection"
export * from "./token-bridge"
