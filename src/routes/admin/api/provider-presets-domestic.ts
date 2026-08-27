/**
 * Builtin Provider Presets: 国内主流服务商
 *
 * 参考 axonhub 官方配置同步最新 2026 前沿大模型体系。
 */

import { DOMESTIC_PRIMARY_PRESETS } from "~/routes/admin/api/provider-presets-domestic-primary"
import { DOMESTIC_SECONDARY_PRESETS } from "~/routes/admin/api/provider-presets-domestic-secondary"

export const DOMESTIC_PRESETS = [
  ...DOMESTIC_PRIMARY_PRESETS,
  ...DOMESTIC_SECONDARY_PRESETS,
]
