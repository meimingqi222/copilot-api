/**
 * Account → Connection 迁移。
 *
 * Phase 5:从 ~/lib/provider-connections/migrate-from-accounts.ts 移入 legacy-accounts/。
 * 此文件为 re-export barrel,实际逻辑仍在 migrate-from-accounts.ts。
 */
export * from "~/lib/provider-connections/migrate-from-accounts"
