/**
 * Provider Presets Builtin Data
 *
 * 33 个内置国内外主流服务商配置清单。
 */

import { DOMESTIC_PRESETS } from "~/routes/admin/api/provider-presets-domestic"
import { OTHERS_PRESETS } from "~/routes/admin/api/provider-presets-others"

export {
  type PresetModel,
  type ProviderPreset,
} from "~/routes/admin/api/provider-presets-types"

export const BUILTIN_PROVIDER_PRESETS = [...DOMESTIC_PRESETS, ...OTHERS_PRESETS]
