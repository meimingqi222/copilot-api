/**
 * Provider Presets 内置预设聚合入口
 *
 * 汇总国内主流服务商与海外/聚合/本地预设，
 * 并提供合并内置预设与用户自定义预设的工具函数。
 */

import type { ProviderPreset } from "~/lib/provider-presets/types"

import { DOMESTIC_PRIMARY_PRESETS } from "~/lib/provider-presets/domestic-primary"
import { DOMESTIC_SECONDARY_PRESETS } from "~/lib/provider-presets/domestic-secondary"
import { OTHERS_PRESETS } from "~/lib/provider-presets/others"

export {
  type PresetModel,
  type ProviderPreset,
} from "~/lib/provider-presets/types"

// 国内主流服务商预设（头部自研 + 平台型/聚合中转）
const DOMESTIC_PRESETS = [
  ...DOMESTIC_PRIMARY_PRESETS,
  ...DOMESTIC_SECONDARY_PRESETS,
]

// 全部内置预设清单
export const BUILTIN_PROVIDER_PRESETS = [...DOMESTIC_PRESETS, ...OTHERS_PRESETS]

/**
 * 合并内置预设与用户自定义预设。
 * 同 id 的用户预设覆盖内置默认，不同 id 的追加到末尾。
 */
export function mergePresets(
  builtin: Array<ProviderPreset>,
  user: Array<ProviderPreset>,
): Array<ProviderPreset> {
  const userMap = new Map(user.map((p) => [p.id, p]))
  const merged: Array<ProviderPreset> = []
  const seen = new Set<string>()

  for (const preset of builtin) {
    seen.add(preset.id)
    merged.push(userMap.get(preset.id) ?? preset)
  }

  for (const preset of user) {
    if (!seen.has(preset.id)) {
      merged.push(preset)
    }
  }

  return merged
}
