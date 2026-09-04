/**
 * Admin API: Provider Presets
 *
 * 预制提供商目录路由。内置预设与合并逻辑已迁移至 ~/lib/provider-presets，
 * 本文件仅保留 HTTP 路由与用户自定义预设读取。
 */

import { Hono } from "hono"
import { readFile } from "node:fs/promises"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
  mergePresets,
} from "~/lib/provider-presets"

// 向后兼容：重新导出类型
export { type PresetModel, type ProviderPreset } from "~/lib/provider-presets"

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

export const providerPresetRoutes = new Hono()

providerPresetRoutes.get("/", async (c) => {
  const userPresets = await readUserPresets()
  const presets = mergePresets(BUILTIN_PROVIDER_PRESETS, userPresets)
  return c.json({ presets })
})
