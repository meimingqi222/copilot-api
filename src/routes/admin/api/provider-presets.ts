/**
 * Admin API: Provider Presets
 *
 * 预制提供商目录。内置 33 个常见主流提供商模板，
 * 并支持从数据目录的 provider-presets.json 读取用户自定义覆盖与扩展。
 */

import { Hono } from "hono"
import { readFile } from "node:fs/promises"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
} from "~/routes/admin/api/provider-presets-data"

export {
  BUILTIN_PROVIDER_PRESETS,
  type PresetModel,
  type ProviderPreset,
} from "~/routes/admin/api/provider-presets-data"

/**
 * 读取用户自定义预设配置文件。
 * 路径：~/.local/share/copilot-api/provider-presets.json
 */
async function readUserPresets(): Promise<Array<ProviderPreset>> {
  try {
    const filePath = PATHS.PROVIDER_PRESETS_PATH
    const content = await readFile(filePath, "utf8")
    const parsed = JSON.parse(content) as { presets?: Array<ProviderPreset> }
    return Array.isArray(parsed.presets) ? parsed.presets : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `[provider-presets] failed to read provider-presets.json: ${(error as Error).message}`,
      )
    }
    return []
  }
}

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

export const providerPresetRoutes = new Hono()

providerPresetRoutes.get("/", async (c) => {
  const userPresets = await readUserPresets()
  const presets = mergePresets(BUILTIN_PROVIDER_PRESETS, userPresets)
  return c.json({ presets })
})
