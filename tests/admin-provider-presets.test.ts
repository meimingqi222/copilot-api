/**
 * 验证 Provider Presets 与即时模型探测接口:
 * 1. GET /admin/api/provider-connections/presets 返回内置 33 个预设
 * 2. 读取用户自定义 provider-presets.json 并正确覆盖/追加
 * 3. POST /admin/api/provider-connections/fetch-models 临时探测模型
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

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { server } from "~/server"

import {
  adminHeaders,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"

const originalFetch = globalThis.fetch
const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-admin-presets-test")

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

beforeEach(() => {
  clearAdminPasswordConfig()
  clearAdminAuth()
  setupAdminAuth()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearAdminAuth()
  clearAdminPasswordConfig()
})

describe("Provider Presets & Fetch Models API", () => {
  test("GET /admin/api/provider-connections/presets returns builtin presets", async () => {
    const res = await adminJson(
      "http://localhost/admin/api/provider-connections/presets",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      presets: Array<{ id: string; name: string }>
    }
    expect(Array.isArray(body.presets)).toBe(true)
    expect(body.presets.length).toBeGreaterThanOrEqual(30)

    const deepseek = body.presets.find((p) => p.id === "deepseek")
    expect(deepseek).toBeDefined()
    expect(deepseek?.name).toBe("DeepSeek (深度求索)")

    const siliconflow = body.presets.find((p) => p.id === "siliconflow")
    expect(siliconflow).toBeDefined()
    expect(siliconflow?.name).toContain("SiliconFlow")
  })

  test("GET /admin/api/provider-connections/presets merges user-defined presets", async () => {
    // 写入自定义 provider-presets.json
    const userConfigFile = PATHS.PROVIDER_PRESETS_PATH
    await fs.writeFile(
      userConfigFile,
      JSON.stringify({
        presets: [
          {
            id: "deepseek",
            name: "DeepSeek (公司内部中转)",
            category: "domestic",
            protocol: "openai-compatible",
            baseUrl: "https://gateway.internal.com/deepseek/v1",
            authMode: "bearer",
          },
          {
            id: "my-custom-vllm",
            name: "自建机房 vLLM 集群",
            category: "custom",
            protocol: "openai-compatible",
            baseUrl: "http://10.0.0.100:8000/v1",
            authMode: "bearer",
          },
        ],
      }),
    )

    const res = await adminJson(
      "http://localhost/admin/api/provider-connections/presets",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      presets: Array<{ id: string; name: string; baseUrl: string }>
    }

    // 覆盖已有 deepseek
    const deepseek = body.presets.find((p) => p.id === "deepseek")
    expect(deepseek?.name).toBe("DeepSeek (公司内部中转)")
    expect(deepseek?.baseUrl).toBe("https://gateway.internal.com/deepseek/v1")

    // 追加新增 my-custom-vllm
    const vllm = body.presets.find((p) => p.id === "my-custom-vllm")
    expect(vllm).toBeDefined()
    expect(vllm?.name).toBe("自建机房 vLLM 集群")
  })

  test("POST /admin/api/provider-connections/fetch-models discovers models via temporary probe", async () => {
    // Mock 上游 /models 响应
    globalThis.fetch = ((input: unknown) => {
      const urlStr = typeof input === "string" ? input : String(input)
      if (urlStr.includes("/models")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "deepseek-ai/DeepSeek-V3",
                  object: "model",
                  owned_by: "deepseek",
                },
                {
                  id: "deepseek-ai/DeepSeek-R1",
                  object: "model",
                  owned_by: "deepseek",
                },
                {
                  id: "Qwen/Qwen2.5-72B-Instruct",
                  object: "model",
                  owned_by: "qwen",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const res = await adminJson(
      "http://localhost/admin/api/provider-connections/fetch-models",
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "openai-compatible",
          baseUrl: "https://api.siliconflow.cn/v1",
          apiKey: "sk-mock-test-key",
          authMode: "bearer",
        }),
      },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      models: Array<{ publicId: string; upstreamId: string; vendor?: string }>
    }
    expect(Array.isArray(body.models)).toBe(true)
    expect(body.models.length).toBe(3)
    expect(body.models.map((m) => m.publicId)).toEqual([
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
    ])
  })

  test("POST /admin/api/provider-connections/fetch-models handles auth error gracefully", async () => {
    // Mock 401
    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Invalid API Key" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch

    const res = await adminJson(
      "http://localhost/admin/api/provider-connections/fetch-models",
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-invalid-key",
          authMode: "bearer",
        }),
      },
    )

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; hint?: string }
    expect(body.hint).toContain("API Key 无效")
  })
})
