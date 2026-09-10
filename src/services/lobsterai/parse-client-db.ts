/**
 * 解析 LobsterAI 客户端本地数据库，提取登录凭证。
 *
 * LobsterAI 客户端把凭证明文存在 SQLite 的 `kv` 表里（不加密）：
 *   - auth_tokens:              {"accessToken":"...","refreshToken":"..."}
 *   - auth_user:                {"yid":"...","id":89559,"nickname":"..."}
 *   - installation_uuid:        "615eef30-..."（refresh 时回传）
 *   - keyfrom.attribution.v1:   {"firstKeyfrom":"official","latestKeyfrom":"official"}
 *
 * 客户端库文件位置（macOS）：
 *   ~/Library/Application Support/LobsterAI/lobsterai.sqlite
 *
 * 这里接收的是**上传上来的字节**，因为 copilot-api 通常部署在远端，
 * 读不到用户本机的文件。注意：
 *
 * 1. bun:sqlite 不能用 `readonly: true` 打开这种库 —— 客户端库是 WAL 模式，
 *    只读连接需要 `-shm` 文件；而上传的只有主库文件，SQLite 在只读模式下
 *    无法自行创建，会抛 SQLITE_CANTOPEN。用读写模式打开临时副本即可。
 * 2. 只有主库文件时，若客户端有未 checkpoint 的 WAL 数据可能读不到。
 *    实测 token 已在主库中，正常场景可用。
 */

import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { logger } from "~/lib/logger"
import { parseJwtPayload } from "~/services/oauth/jwt"

/** kv 表中与凭证相关的键。 */
const KV_KEYS = {
  authTokens: "auth_tokens",
  authUser: "auth_user",
  installationUuid: "installation_uuid",
  keyfrom: "keyfrom.attribution.v1",
} as const

export interface ParsedLobsteraiClientCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  uid?: string
  yid?: string
  nickname?: string
  uuid?: string
  firstKeyfrom?: string
  latestKeyfrom?: string
}

/** 读取 kv 表中的一个键，返回值按 JSON 解析（解析失败则返回原始字符串）。 */
function readKv(db: Database, key: string): unknown {
  const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as {
    value?: unknown
  } | null
  const raw = row?.value
  if (typeof raw !== "string") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    // auth_tokens 等是 JSON；installation_uuid 之类的裸字符串走这里。
    return raw
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

/** 从 JWT `exp`（秒）得到毫秒时间戳。 */
function jwtExpiryMs(token: string): number | undefined {
  const exp = parseJwtPayload(token)?.exp
  return typeof exp === "number" && Number.isFinite(exp) ?
      Math.floor(exp * 1000)
    : undefined
}

/**
 * 解析 LobsterAI 客户端数据库字节，返回归一化凭证。
 *
 * 无法识别（不是 SQLite、缺表、未登录）时抛错，由调用方转成 400。
 * 临时文件始终清理。
 */
export async function parseLobsteraiClientDatabase(
  bytes: Uint8Array,
): Promise<ParsedLobsteraiClientCredentials> {
  if (bytes.byteLength === 0) {
    throw new Error("上传的文件为空")
  }

  // SQLite 文件头魔数，先做一次廉价校验，避免把任意文件写盘解析。
  const MAGIC = "SQLite format 3\0"
  const header = Buffer.from(bytes.subarray(0, MAGIC.length)).toString("latin1")
  if (header !== MAGIC) {
    throw new Error("这不是一个 SQLite 数据库文件")
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-db-"))
  const dbPath = path.join(dir, "client.sqlite")
  let db: Database | undefined
  try {
    await fs.writeFile(dbPath, bytes)
    // 读写模式（见文件头注释：只读模式需要 -shm，会在 CANTOPEN 上失败）。
    db = new Database(dbPath)

    const tokens = asRecord(readKv(db, KV_KEYS.authTokens))
    const accessToken = asString(tokens.accessToken)
    if (!accessToken) {
      throw new Error(
        "数据库里没有找到登录凭证（auth_tokens）。请先在 LobsterAI 客户端登录。",
      )
    }

    const user = asRecord(readKv(db, KV_KEYS.authUser))
    const keyfrom = asRecord(readKv(db, KV_KEYS.keyfrom))
    const installationUuid = readKv(db, KV_KEYS.installationUuid)

    // userId 在客户端库里叫 `id`（数字），部分版本叫 `userId`。
    const rawUid = user.userId ?? user.id
    let uid: string | undefined
    if (typeof rawUid === "number") {
      uid = String(rawUid)
    } else if (typeof rawUid === "string" && rawUid.trim()) {
      uid = rawUid.trim()
    }

    return {
      accessToken,
      refreshToken: asString(tokens.refreshToken),
      expiresAt: jwtExpiryMs(accessToken),
      uid,
      yid: asString(user.yid),
      nickname: asString(user.nickname),
      uuid: asString(installationUuid),
      firstKeyfrom: asString(keyfrom.firstKeyfrom),
      latestKeyfrom: asString(keyfrom.latestKeyfrom),
    }
  } finally {
    db?.close()
    await fs
      .rm(dir, { recursive: true, force: true })
      .catch((error: unknown) => {
        logger.warn(
          "[lobsterai] failed to clean up temp db dir:",
          error instanceof Error ? error.message : error,
        )
      })
  }
}
