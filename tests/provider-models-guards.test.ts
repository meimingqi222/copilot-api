/**
 * Provider 模型管理 API:
 * 1. aliases 在普通 connection 上可增删改查(POST/PUT/GET)。
 * 2. account-managed connection 只允许改名/开关/别名;
 *    改 upstreamId、增删模型直接 409(会被 provider 刷新覆盖/恢复)。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { listAccounts } from "~/lib/legacy-accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  addModel,
  createConnection,
} from "~/lib/provider-connections"
import { server } from "~/server"

import {
  adminHeaders,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-provider-models-test")

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(
    new Request(url, {
      ...init,
      headers,
    }),
  )
}

beforeAll(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
})

afterAll(async () => {
  redirectPathsToDir(isolationRoot)
  try {
    await fs.rm(testDir, { force: true, recursive: true })
  } catch {
    // ignore
  }
})

beforeEach(async () => {
  clearAdminPasswordConfig()
  clearAdminAuth()
  setupAdminAuth()
  __resetProviderConnectionsForTest()
  await createConnection({
    id: "acc-copilot",
    name: "Copilot 账号",
    protocol: "copilot-native",
    baseUrl: "https://api.githubcopilot.com",
    models: [
      {
        publicId: "gpt-4o",
        upstreamId: "gpt-4o",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
  await createConnection({
    id: "prov-openai",
    name: "OpenAI 兼容",
    protocol: "openai-compatible",
    baseUrl: "https://example.com/v1",
    models: [
      {
        publicId: "m1",
        upstreamId: "m1",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
})

describe("provider model aliases", () => {
  test("PUT aliases 写入后 GET 可见,空数组清空", async () => {
    let res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models/m1",
      {
        method: "PUT",
        body: JSON.stringify({ aliases: ["legacy-m1", "M1"] }),
      },
    )
    expect(res.status).toBe(200)
    const putBody = (await res.json()) as {
      model: { aliases?: Array<string> }
    }
    expect(putBody.model.aliases).toEqual(["legacy-m1", "M1"])

    res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai",
    )
    const getBody = (await res.json()) as {
      connection: { models: Array<{ aliases?: Array<string> }> }
    }
    expect(getBody.connection.models[0].aliases).toEqual(["legacy-m1", "M1"])

    res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models/m1",
      { method: "PUT", body: JSON.stringify({ aliases: [] }) },
    )
    expect(res.status).toBe(200)
    const cleared = (await res.json()) as {
      model: { aliases?: Array<string> }
    }
    expect(cleared.model.aliases).toBeUndefined()
  })

  test("POST 单个/批量支持 aliases", async () => {
    const res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models",
      {
        method: "POST",
        body: JSON.stringify({
          publicId: "m2",
          upstreamId: "m2",
          aliases: ["old-m2"],
        }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      model: { aliases?: Array<string> }
    }
    expect(body.model.aliases).toEqual(["old-m2"])
  })
})

describe("account-managed model guards", () => {
  test("模型清单可读", async () => {
    const res = await adminJson(
      "http://localhost/admin/api/accounts/acc-copilot/models",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      models: Array<{ publicId: string }>
    }
    expect(body.models.map((m) => m.publicId)).toEqual(["gpt-4o"])
  })

  test("改名/开关/别名允许", async () => {
    let res = await adminJson(
      "http://localhost/admin/api/accounts/acc-copilot/models/gpt-4o",
      { method: "PUT", body: JSON.stringify({ publicId: "my-gpt" }) },
    )
    expect(res.status).toBe(200)

    res = await adminJson(
      "http://localhost/admin/api/accounts/acc-copilot/models/my-gpt",
      {
        method: "PUT",
        body: JSON.stringify({ enabled: false, aliases: ["eg"] }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      model: { enabled: boolean; aliases?: Array<string> }
    }
    expect(body.model.enabled).toBe(false)
    expect(body.model.aliases).toEqual(["eg"])
  })

  test("改 upstreamId/endpoints 直接 409", async () => {
    const res = await adminJson(
      "http://localhost/admin/api/accounts/acc-copilot/models/gpt-4o",
      { method: "PUT", body: JSON.stringify({ upstreamId: "other" }) },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("provider-driven")
  })

  test("不存在的账号 404", async () => {
    const res = await adminJson(
      "http://localhost/admin/api/accounts/nope/models",
    )
    expect(res.status).toBe(404)
  })

  test("无 credential 的连接不炸 listAccounts", () => {
    // 回归:getConnectionCooldownUntil 曾对 credentials[0] 裸解引用,
    // 先建连接后加凭据的合法状态会让账号列表崩溃。
    expect(() => listAccounts()).not.toThrow()
  })
})

describe("model name collisions", () => {
  test("provider:别名撞兄弟 publicId 直接 409", async () => {
    let res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models",
      {
        method: "POST",
        body: JSON.stringify({ publicId: "m2", upstreamId: "m2" }),
      },
    )
    expect(res.status).toBe(201)

    res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models/m1",
      { method: "PUT", body: JSON.stringify({ aliases: ["m2"] }) },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("already used")
  })

  test("provider:改名撞兄弟别名直接 409", async () => {
    let res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models",
      {
        method: "POST",
        body: JSON.stringify({
          publicId: "m2",
          upstreamId: "m2",
          aliases: ["eg2"],
        }),
      },
    )
    expect(res.status).toBe(201)

    res = await adminJson(
      "http://localhost/admin/api/provider-connections/prov-openai/models/m1",
      { method: "PUT", body: JSON.stringify({ publicId: "eg2" }) },
    )
    expect(res.status).toBe(409)
  })

  test("account:别名撞兄弟 publicId 直接 409", async () => {
    await addModel("acc-copilot", {
      publicId: "other",
      upstreamId: "other",
      endpoints: ["chat"],
      enabled: true,
    })
    const res = await adminJson(
      "http://localhost/admin/api/accounts/acc-copilot/models/gpt-4o",
      { method: "PUT", body: JSON.stringify({ aliases: ["other"] }) },
    )
    expect(res.status).toBe(409)
  })
})
