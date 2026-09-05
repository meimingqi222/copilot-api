/**
 * users.json 热路径写放大回归测试:token 计数内存聚合 + 合并落盘。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { state } from "~/lib/state"
import {
  createUser,
  flushUserTokens,
  incrementUserTokens,
  resetUserTokens,
  stopUserTokenFlusherForTest,
} from "~/lib/users"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `users-flush-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  state.users = []
})

afterEach(async () => {
  stopUserTokenFlusherForTest()
  state.users = []
  redirectPathsToDir(isolationRoot)
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

async function readPersistedUsers(): Promise<
  Array<{ id: string; usedTokens: number }>
> {
  const raw = await fs.readFile(PATHS.USERS_PATH)
  return JSON.parse(raw.toString()) as Array<{
    id: string
    usedTokens: number
  }>
}

describe("user token coalesced flush", () => {
  test("increments accumulate in memory without touching disk", async () => {
    const created = await createUser("alice")
    expect((await readPersistedUsers())[0]?.usedTokens).toBe(0)

    await incrementUserTokens(created.id, 100)
    await incrementUserTokens(created.id, 50)

    const user = state.users.find((u) => u.id === created.id)
    expect(user?.usedTokens).toBe(150)
    // 未 flush 前磁盘仍是旧值。
    expect((await readPersistedUsers())[0]?.usedTokens).toBe(0)

    await flushUserTokens()
    expect((await readPersistedUsers())[0]?.usedTokens).toBe(150)
  })

  test("concurrent increments never lose counts", async () => {
    const created = await createUser("bob")
    await Promise.all(
      Array.from({ length: 50 }, () => incrementUserTokens(created.id, 7)),
    )

    const user = state.users.find((u) => u.id === created.id)
    expect(user?.usedTokens).toBe(350)

    await flushUserTokens()
    expect((await readPersistedUsers())[0]?.usedTokens).toBe(350)
  })

  test("flush with no changes is a no-op", async () => {
    const created = await createUser("carol")
    const before = await fs.stat(PATHS.USERS_PATH).then((s) => s.mtimeMs)
    await flushUserTokens()
    const after = await fs.stat(PATHS.USERS_PATH).then((s) => s.mtimeMs)
    expect(after).toBe(before)
    expect(created.usedTokens).toBe(0)
  })

  test("structural ops still persist immediately", async () => {
    const created = await createUser("dave")
    await incrementUserTokens(created.id, 42)
    // resetUserTokens 是管理操作:立即落盘(含之前的计数清零语义)。
    await resetUserTokens(created.id)
    expect((await readPersistedUsers())[0]?.usedTokens).toBe(0)
    const user = state.users.find((u) => u.id === created.id)
    expect(user?.usedTokens).toBe(0)
  })

  test("unknown user increments report false", async () => {
    expect(await incrementUserTokens("no-such-user", 10)).toBe(false)
  })
})
