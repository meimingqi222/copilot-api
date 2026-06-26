import fs from "node:fs"

import { PATHS } from "~/lib/paths"

export type FileLogLevel = "debug" | "info" | "warn" | "error"

export interface FileLogMeta {
  [key: string]: unknown
}

/**
 * Global file logger that persists structured log lines to disk.
 *
 * Unlike `LogStore` (in-memory ring buffer for the admin dashboard), this
 * logger is intended for cross-provider diagnostic logging — any module can
 * import `fileLogger` and emit lines that survive process restarts, which
 * makes post-mortem debugging of streaming/usage issues practical.
 *
 * Writes are best-effort: failures are swallowed so logging never breaks the
 * main request flow.
 */
class FileLogger {
  log(level: FileLogLevel, message: string, meta?: FileLogMeta): void {
    try {
      const ts = new Date().toISOString()
      const metaStr =
        meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
      const line = `${ts} [${level.toUpperCase()}] ${message}${metaStr}\n`
      fs.appendFileSync(PATHS.LOG_FILE, line)
    } catch {
      // best-effort; never let logging break the main flow
    }
  }

  debug(message: string, meta?: FileLogMeta): void {
    this.log("debug", message, meta)
  }

  info(message: string, meta?: FileLogMeta): void {
    this.log("info", message, meta)
  }

  warn(message: string, meta?: FileLogMeta): void {
    this.log("warn", message, meta)
  }

  error(message: string, meta?: FileLogMeta): void {
    this.log("error", message, meta)
  }
}

export const fileLogger = new FileLogger()
