/**
 * Trae 的会话 session_id。
 *
 * Trae 按 session_id 计「一次会话」：一次用户发送若分多步（回传工具结果、
 * 重试、换 function 应答）各用一个新 id，用量明细就会拆成多条无标题记录。
 * 所以同一会话的每个请求带同一个 session_id（按会话首条用户消息 + 账号做
 * 盐哈希），request_id 仍每请求一新。盐落盘在本机数据目录，进程重启后会话
 * 不被算成新开的——与 magpie 的 trae-session-salt 同构。
 *
 * 盐只用于派生 id，不向 Trae 透露原文；账号（uid）并入派生，故同一会话被
 * 两个账号应答（故障转移/轮换）时算两次会话，Trae 不会把一个账号的会话
 * 读成另一个的。
 */

import { createHash, randomBytes } from "node:crypto"
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

const SALT_SHAPE = /^[0-9a-f]{32}$/
let salt = ""

function saltFile(): string {
  return (
    process.env.TRAE_SESSION_SALT?.trim()
    || path.join(PATHS.APP_DIR, "trae-session-salt")
  )
}

/** 本机盐：读不到/造不出就用进程自己的一次性盐（不阻断请求）。 */
function traeSessionSalt(): string {
  if (salt) return salt
  const file = saltFile()
  const read = (): string | null => {
    try {
      const s = readFileSync(file, "utf8").trim()
      return SALT_SHAPE.test(s) ? s : null
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "" : null
    }
  }
  let s = read()
  if (s === "") {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(tmp, randomBytes(16).toString("hex") + "\n", {
        mode: 0o600,
      })
      try {
        linkSync(tmp, file)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      }
      s = read()
    } catch {
      s = null
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
  salt = s || randomBytes(16).toString("hex")
  return salt
}

/** 测试用：重置进程盐。 */
export function __resetTraeSessionSaltForTest(): void {
  salt = ""
}

/** 哈希前 16 字节做成 v4 UUID 形状（session_id 历来是 UUID）。 */
function uuidOf(s: string): string {
  const b = Buffer.from(
    createHash("sha256")
      .update(traeSessionSalt() + "|" + s)
      .digest()
      .subarray(0, 16),
  )
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function firstUserText(payload: ChatCompletionsPayload): string {
  const first = (payload.messages ?? []).find((m) => m.role === "user")
  const content = first?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => {
      if (typeof p === "string") return p
      const part = p as { type?: string; text?: string }
      return part?.type === "text" || part?.type === "input_text" ?
          (part.text ?? "")
        : ""
    })
    .join("\n")
}

/**
 * 会话 id：显式 session 优先，否则按首条用户消息（每轮重复）+ 账号派生；
 * 都没有则 ""（调用方退回每请求一新的随机 id）。
 */
export function traeConversationId(
  payload: ChatCompletionsPayload,
  session: string,
  who = "",
): string {
  const account = String(who ?? "").trim()
  if (session) return uuidOf("trae-session|" + account + "|" + session)
  const text = firstUserText(payload).trim()
  return text ? uuidOf("trae-first|" + account + "|" + text) : ""
}
