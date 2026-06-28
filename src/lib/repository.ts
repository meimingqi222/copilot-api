import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "~/lib/logger"

// ── Mutex ─────────────────────────────────────────────────────────

/**
 * 互斥锁,确保异步操作串行执行。
 * 来自 account-store.ts 的 Mutex 类,提取为独立模块供 Repository 使用。
 */
export class Mutex {
  private queue: Promise<void> = Promise.resolve()

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = this.queue
    this.queue = next
    try {
      await prev
      return await fn()
    } finally {
      release()
    }
  }
}

// ── Atomic file write (来自 account-file-store.ts 基线) ────────────

const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"])
const RENAME_RETRY_COUNT = 3
const RENAME_RETRY_DELAY_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
  })
}

async function retryRename(src: string, dest: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_RETRY_COUNT; attempt++) {
    try {
      await fs.rename(src, dest)
      return
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ?
          ((error as { code: unknown }).code as string)
        : undefined
      if (
        code
        && RENAME_RETRYABLE_CODES.has(code)
        && attempt < RENAME_RETRY_COUNT
      ) {
        logger.debug(
          `[repository] rename retry ${attempt}/${RENAME_RETRY_COUNT} (code=${code})`,
        )
        await sleep(RENAME_RETRY_DELAY_MS * attempt)
        continue
      }
      throw error
    }
  }
}

// ── Repository ────────────────────────────────────────────────────

interface RepositoryConfig<T> {
  filePath: string | (() => string)
  serialize: (data: T) => string
  deserialize: (raw: string) => T
  corruptMessage?: string
  /** When false, skip .bak update before writing (accounts shrink guard). */
  shouldCreateBackup?: (filePath: string) => Promise<boolean>
}

/**
 * 统一持久化基类。
 *
 * 提供两种并发模式以匹配现有语义:
 * - `save()` — 仅锁文件写,不串行化内存状态变更(匹配 account-store 行为)
 * - `mutate()` — 串行化 mutation + 持久化 + 失败回滚(匹配 provider-connections 行为)
 *
 * 原子写入特性(来自 account-file-store 基线):
 * - tmp file + rename
 * - .bak 备份
 * - Windows EPERM/EBUSY/EACCES 重试
 * - corrupt 检测
 */
export class Repository<T> {
  private mutex = new Mutex()
  private config: RepositoryConfig<T>

  constructor(config: RepositoryConfig<T>) {
    this.config = config
  }

  private getFilePath(): string {
    const { filePath } = this.config
    return typeof filePath === "function" ? filePath() : filePath
  }

  /** 仅锁文件写,不串行化内存状态变更。匹配 account-store 现有语义。 */
  async save(data: T): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.atomicWrite(this.config.serialize(data))
    })
  }

  /** 串行化 mutation + 持久化 + 失败回滚。匹配 provider-connections 现有语义。 */
  async mutate<R>(
    snapshot: () => T,
    apply: () => R | Promise<R>,
    rollback: (prev: T) => void,
  ): Promise<R> {
    return this.mutex.runExclusive(async () => {
      const prev = snapshot()
      try {
        const result = await apply()
        await this.atomicWrite(this.config.serialize(snapshot()))
        return result
      } catch (error) {
        rollback(prev)
        throw error
      }
    })
  }

  /**
   * 从磁盘加载。文件不存在时返回 null。
   * 尝试从 .bak 恢复(如主文件损坏)。
   */
  async load(): Promise<T | null> {
    const filePath = this.getFilePath()

    let raw: string | undefined
    try {
      raw = await fs.readFile(filePath, "utf8")
    } catch (error: unknown) {
      const code = (error as { code?: string } | undefined)?.code
      if (code === "ENOENT") return null
      // 非 ENOENT:尝试 .bak
      logger.warn(
        `[repository] Failed to read ${path.basename(filePath)}: ${(error as Error).message}, trying .bak`,
      )
      const backupPath = getBackupPath(filePath)
      try {
        raw = await fs.readFile(backupPath, "utf8")
        await fs.copyFile(backupPath, filePath)
        logger.warn(`Recovered ${path.basename(filePath)} from .bak backup.`)
      } catch {
        return null
      }
    }

    if (raw.trim() === "") return null

    try {
      return this.config.deserialize(raw)
    } catch {
      // corrupt:尝试 .bak
      const backupPath = getBackupPath(filePath)
      try {
        const backupRaw = await fs.readFile(backupPath, "utf8")
        const result = this.config.deserialize(backupRaw)
        await fs.copyFile(backupPath, filePath)
        logger.warn(
          `Recovered ${path.basename(filePath)} from .bak backup (corrupt).`,
        )
        return result
      } catch {
        logger.error(
          this.config.corruptMessage ?? `File ${filePath} is corrupt.`,
        )
        return null
      }
    }
  }

  /** tmp file + copyFile(.bak) + retryRename。来自 account-file-store 基线。 */
  private async atomicWrite(content: string): Promise<void> {
    const filePath = this.getFilePath()
    const tmpPath = filePath + `.tmp.${process.pid}`

    await fs.mkdir(path.dirname(filePath), { recursive: true })

    const backupPath = getBackupPath(filePath)
    const shouldBackup =
      this.config.shouldCreateBackup ?
        await this.config.shouldCreateBackup(filePath)
      : true
    if (shouldBackup) {
      try {
        await fs.copyFile(filePath, backupPath)
      } catch {
        // 文件可能还不存在,忽略
      }
    }

    // 写入 tmp 文件
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 })

    // rename (含 Windows 重试)
    try {
      await retryRename(tmpPath, filePath)
    } catch (error) {
      // rename 失败时清理 tmp 文件,避免残留
      await fs.unlink(tmpPath).catch((error: unknown) => {
        logger.debug(`Failed to cleanup temp file: ${(error as Error).message}`)
      })
      throw error
    }

    try {
      await fs.chmod(filePath, 0o600)
    } catch {
      // chmod 在某些平台(Windows)上会失败,忽略
    }
  }
}

function getBackupPath(filePath: string): string {
  return filePath + ".bak"
}
