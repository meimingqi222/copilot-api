/**
 * Claude Code 转录的保留期清理。
 *
 * Claude Code 把**完整对话正文**写进 `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/*.jsonl`。
 * 我们把 `CLAUDE_CONFIG_DIR` 指向自己的数据目录（`claudeConfigDir`），
 * 所以用户真实的 `~/.claude` 不会被写；但那个目录会无界增长。
 *
 * 这个模块负责把它压回一个有界的窗口。
 *
 * 只碰 `<configDir>/projects` 下的 `*.jsonl`。整个 configDir 归我们所有，
 * 所以不会误删用户自己的 Claude 数据 —— 这是设置 `CLAUDE_CONFIG_DIR`
 * 换来的最重要的性质。
 *
 * 参考 magpie 的做法：它用一次性 temp cwd，转录散落在系统 temp 里随系统清理；
 * 我们要保留稳定 cwd（prompt cache 需要），所以必须自己清理。
 */

import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "~/lib/logger"

/** 默认保留 7 天。 */
const DEFAULT_TTL_DAYS = 7

/** 清理最多每小时跑一次，避免每个回合都扫目录。 */
const PRUNE_INTERVAL_MS = 60 * 60_000

let lastPruneAt = 0

export function claudeTranscriptTtlDays(): number {
  const raw = process.env.COPILOT_API_CLAUDE_TRANSCRIPT_TTL_DAYS?.trim()
  if (!raw) return DEFAULT_TTL_DAYS
  const parsed = Number.parseInt(raw, 10)
  // 0 或负数表示不清理（把决定权明确交给运维）。
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_DAYS
  return parsed
}

/** 测试用：复位节流。 */
export function resetClaudeTranscriptPruneForTest(): void {
  lastPruneAt = 0
}

/**
 * 删掉 `configDir/projects` 下超过保留期的转录文件。
 *
 * 返回删除的文件数。任何错误都被吞掉：清理是尽力而为的后台工作，
 * 不该让一次请求失败。
 */
export async function pruneClaudeTranscripts(
  configDir: string,
  now = Date.now(),
): Promise<number> {
  const ttlDays = claudeTranscriptTtlDays()
  if (ttlDays <= 0) return 0
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0
  lastPruneAt = now

  const cutoff = now - ttlDays * 24 * 60 * 60_000
  const projectsDir = path.join(configDir, "projects")
  let removed = 0
  try {
    for (const slug of await fs.readdir(projectsDir)) {
      const slugDir = path.join(projectsDir, slug)
      let entries: Array<string>
      try {
        entries = await fs.readdir(slugDir)
      } catch {
        continue // 不是目录，或已经消失
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue
        const file = path.join(slugDir, entry)
        try {
          const stat = await fs.stat(file)
          if (stat.mtimeMs >= cutoff) continue
          await fs.rm(file, { force: true })
          removed += 1
        } catch {
          // 单个文件失败不影响其余
        }
      }
    }
  } catch {
    return removed // projects 目录还不存在
  }
  if (removed > 0) {
    logger.debug(
      `claude-cli: pruned ${removed} transcript file(s) older than ${ttlDays} day(s)`,
    )
  }
  return removed
}
