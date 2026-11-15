import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

import { logger } from "~/lib/logger"
import type { AcpUsage } from "~/services/antigravity/acp/client"
import { parseMessage } from "~/services/windsurf/protobuf"

/** agy 1.5.x persists completed ModelUsageStats before invoking MCP tools. */
export class AgyStepUsage {
  private readonly databasePath: string
  private cursor = -1
  private cumulative: AcpUsage = {}
  private warned = false

  constructor(databasePath: string) {
    this.databasePath = databasePath
  }

  startPrompt(): void {
    this.cumulative = {}
    this.withDatabase((db) => {
      const row = db
        .query<
          { idx: number | null },
          []
        >("SELECT MAX(idx) AS idx FROM gen_metadata")
        .get()
      this.cursor = row?.idx ?? -1
    })
  }

  read(): { step: AcpUsage; cumulative: AcpUsage } | undefined {
    let step: AcpUsage | undefined
    this.withDatabase((db) => {
      const rows = db
        .query<
          { idx: number; data: Uint8Array },
          [number]
        >("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
        .all(this.cursor)
      for (const row of rows) {
        const usage = generationUsage(row.data)
        if (!usage) continue
        step = usage
        for (const key of Object.keys(usage) as Array<keyof AcpUsage>) {
          this.cumulative[key] = (this.cumulative[key] ?? 0) + usage[key]!
        }
        this.cursor = row.idx
      }
    })
    return step ? { step, cumulative: { ...this.cumulative } } : undefined
  }

  private withDatabase(read: (db: Database) => void): void {
    if (!existsSync(this.databasePath)) return
    let db: Database | undefined
    try {
      db = new Database(this.databasePath, { readonly: true })
      read(db)
    } catch {
      if (!this.warned) {
        logger.warn(
          "Antigravity native step usage unavailable; preserving billing without estimating client usage",
        )
        this.warned = true
      }
    } finally {
      db?.close()
    }
  }
}

function generationUsage(data: Uint8Array): AcpUsage | undefined {
  // Decode only the metadata envelope and ModelUsageStats. Other fields contain
  // prompts and model text, which must not be recursively decoded or logged.
  const meta = parseMessage(data, 0, 0).find((node) => node.field === 1)?.raw
  if (!meta) return undefined
  const raw = parseMessage(meta, 0, 0).find((node) => node.field === 4)?.raw
  if (!raw) return undefined
  const values = new Map(
    parseMessage(raw, 0, 0)
      .filter((node) => node.wire === 0 && node.varint !== undefined)
      .map((node) => [node.field, node.varint!]),
  )
  if (![2, 3, 4, 5].some((field) => values.has(field))) return undefined
  const inputTokens = values.get(2) ?? 0
  const outputTokens = values.get(3) ?? 0
  const cachedWriteTokens = values.get(4) ?? 0
  const cachedReadTokens = values.get(5) ?? 0
  return {
    inputTokens,
    outputTokens,
    cachedWriteTokens,
    cachedReadTokens,
    ...(values.has(9) ? { thoughtTokens: values.get(9) } : {}),
    totalTokens:
      inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
  }
}
