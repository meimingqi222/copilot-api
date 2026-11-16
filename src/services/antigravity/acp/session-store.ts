/**
 * Persisted native ACP session index. After a completed turn the bridge records
 * the session ID with the request prefix it answered; a later request whose
 * history extends that prefix can reattach via `session/resume` instead of
 * cold-replaying the whole transcript. Only IDs and hashes are stored, never
 * message text. Entries expire and are capped; a stale or ambiguous match is
 * ignored so the caller falls back to a fresh session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import type { Message } from "~/services/protocols/chat/types"

import { hashMessages } from "./prompt"

export interface ParkedSession {
  sessionId: string
  connectionId: string
  model: string
  toolsSignature: string
  ownerKey: string
  messageCount: number
  historyHash: string
  assistantHash: string
  updatedAt: number
}

const RESUME_TTL_MS = 6 * 60 * 60 * 1000
const MAX_PARKED = 64

function storePath(): string {
  return path.join(PATHS.APP_DIR, "antigravity-acp", "sessions.json")
}

function load(): Array<ParkedSession> {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as {
      entries?: Array<ParkedSession>
    }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

function save(entries: Array<ParkedSession>): void {
  const file = storePath()
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, entries }), {
      mode: 0o600,
    })
    renameSync(temp, file)
  } catch {
    // Persistence is best-effort; a failed write only loses resume optimisation.
  }
}

export function recordSession(entry: ParkedSession): void {
  const now = Date.now()
  const entries = load().filter(
    (item) =>
      item.sessionId !== entry.sessionId
      && now - item.updatedAt <= RESUME_TTL_MS,
  )
  entries.push({ ...entry, updatedAt: now })
  while (entries.length > MAX_PARKED) entries.shift()
  save(entries)
}

/**
 * Find a persisted session this request can resume. The stored history must be
 * an exact prefix of the incoming messages and the delta a new caller turn. A
 * single prefix match resumes directly; several matches are disambiguated by the
 * assistant echo, and an unresolved ambiguity returns nothing (fresh replay).
 */
export function findResumable(params: {
  connectionId: string
  model: string
  toolsSignature: string
  ownerKey: string
  messages: Array<Message>
}): ParkedSession | undefined {
  const { connectionId, model, toolsSignature, ownerKey, messages } = params
  const now = Date.now()
  const matches = load().filter((entry) => {
    if (
      entry.connectionId !== connectionId
      || entry.model !== model
      || entry.toolsSignature !== toolsSignature
      || entry.ownerKey !== ownerKey
      || now - entry.updatedAt > RESUME_TTL_MS
      || entry.messageCount <= 0
      || messages.length <= entry.messageCount + 1
    ) {
      return false
    }
    if (
      hashMessages(messages.slice(0, entry.messageCount)) !== entry.historyHash
    ) {
      return false
    }
    return messages
      .slice(entry.messageCount + 1)
      .every(
        (msg) =>
          msg.role === "user"
          || msg.role === "system"
          || msg.role === "developer",
      )
  })
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]
  const byEcho = matches.filter(
    (entry) =>
      hashMessages([messages[entry.messageCount]]) === entry.assistantHash,
  )
  return byEcho.length === 1 ? byEcho[0] : undefined
}
