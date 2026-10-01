import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  selectRouteTarget,
  selectGroupRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { clearSessionAffinityForTest } from "~/lib/routing"
import { CACHE_UTILIZATION_DEFAULTS } from "~/lib/routing/provider-cache"
import {
  clearRoutingGroupsCacheForTest,
  getRoutingGroup,
  listRoutingGroups,
  upsertRoutingGroup,
  validateGroup,
} from "~/lib/routing-groups"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import type { User } from "~/lib/users"
import { modelRoutes } from "~/routes/models/route"

const originalPath = PATHS.APP_DIR
const originalRouting = { ...state.routing }
const originalModels = state.models
let testDir: string

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-policy-"))
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  clearRoutingGroupsCacheForTest()
  clearSessionAffinityForTest()
  Object.assign(state.routing, CACHE_UTILIZATION_DEFAULTS)
})

afterEach(async () => {
  redirectPathsToDir(originalPath)
  __resetProviderConnectionsForTest()
  clearRoutingGroupsCacheForTest()
  clearSessionAffinityForTest()
  Object.assign(state.routing, originalRouting)
  state.models = originalModels
  await fs.rm(testDir, { recursive: true, force: true })
})

function connection(id: string, remaining: number, priority = 10) {
  const now = Date.now()
  const conn: ProviderConnection = {
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    enabled: true,
    priority,
    createdAt: now,
    models: [
      {
        publicId: "deepseek-v4.1-flash",
        upstreamId: "deepseek-v4.1-flash",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
    credentials: [
      {
        id: `${id}-key`,
        authMode: "bearer",
        value: "test",
        status: "ready",
        enabled: true,
        createdAt: now,
        quota: {
          fetchedAt: now,
          unlimited: false,
          chatRemaining: remaining,
          chatTotal: 100,
        },
      },
    ],
  }
  upsertProviderConnection(conn)
  return conn
}

function plain(sessionId?: string, exclude?: Set<string>) {
  return selectRouteTarget(
    buildRouteTargets({
      publicModelId: "deepseek-v4.1-flash",
      endpoint: "chat",
    }),
    { sessionId, exclude },
  )
}

function grouped(sessionId?: string, exclude?: Set<string>) {
  return selectGroupRouteTarget(
    ["alpha/deepseek-v4.1-flash", "beta/deepseek-v4.1-flash"],
    {
      endpoint: "chat",
      routing: "smart",
      groupId: "custom",
      sessionId,
      exclude,
    },
  )
}

async function catalog(user?: User) {
  cacheModels()
  const app = new Hono()
  if (user)
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never)
      await next()
    })
  app.route("/models", modelRoutes)
  const response = await app.request("/models")
  expect(response.status).toBe(200)
  return (await response.json()) as {
    data: Array<{ id: string; name: string }>
  }
}

test("a bare model and a smart custom group use the same default quota and priority policy", () => {
  connection("alpha", 3)
  const beta = connection("beta", 60)
  expect(state.routing.strategy).toBe("quota")
  expect(plain()?.connectionId).toBe("beta")
  expect(grouped()?.connectionId).toBe("beta")
  beta.priority = 20
  upsertProviderConnection(beta)
  expect(plain()?.connectionId).toBe("alpha")
  expect(grouped()?.connectionId).toBe("alpha")
  const tried = new Set([targetKey(plain()!)])
  expect(plain(undefined, tried)?.connectionId).toBe("beta")
  expect(grouped(undefined, tried)?.connectionId).toBe("beta")
})

test("both entry points retain low accounts, release spent bindings and honor changed priority", () => {
  const alpha = connection("alpha", 60)
  const beta = connection("beta", 3)
  expect(plain("plain")?.connectionId).toBe("alpha")
  expect(grouped("group")?.connectionId).toBe("alpha")
  alpha.credentials[0].quota!.chatRemaining = 5
  beta.credentials[0].quota!.chatRemaining = 60
  upsertProviderConnection(alpha)
  upsertProviderConnection(beta)
  expect(plain("plain")?.connectionId).toBe("alpha")
  expect(grouped("group")?.connectionId).toBe("alpha")
  alpha.credentials[0].quota!.chatRemaining = 1
  upsertProviderConnection(alpha)
  expect(plain("plain")?.connectionId).toBe("beta")
  expect(grouped("group")?.connectionId).toBe("beta")
  alpha.priority = 0
  alpha.credentials[0].quota!.chatRemaining = 60
  upsertProviderConnection(alpha)
  expect(plain("plain")?.connectionId).toBe("alpha")
  expect(grouped("group")?.connectionId).toBe("alpha")
})

test("same-name providers add one catalog model and no synthetic group rows", async () => {
  for (let i = 0; i < 40; i++) connection(`provider-${i}`, 60)
  const models = await catalog()
  expect(models.data.map((model) => model.id)).toEqual(["deepseek-v4.1-flash"])
  expect(await listRoutingGroups()).toEqual([])
  expect(await getRoutingGroup("auto-deepseek-v4-1-flash")).toMatchObject({
    routing: "smart",
  })
})

test("a spent primary yields to a healthy backup for both entry points", () => {
  const alpha = connection("alpha", 60, 0)
  connection("beta", 60, 10)
  expect(plain("plain")?.connectionId).toBe("alpha")
  expect(grouped("group")?.connectionId).toBe("alpha")
  alpha.credentials[0].quota!.chatRemaining = 1
  upsertProviderConnection(alpha)
  expect(plain("plain")?.connectionId).toBe("beta")
  expect(grouped("group")?.connectionId).toBe("beta")
})

test("custom groups are hidden by default and exposure persists without exposing members again", async () => {
  connection("alpha", 60)
  connection("beta", 3)
  const group = {
    id: "custom",
    name: "My fallback",
    members: ["alpha/deepseek-v4.1-flash", "beta/deepseek-v4.1-flash"],
    rules: [],
  }
  await upsertRoutingGroup(group)
  expect((await catalog()).data.map((model) => model.id)).toEqual([
    "deepseek-v4.1-flash",
  ])
  await upsertRoutingGroup({ ...group, expose: true })
  clearRoutingGroupsCacheForTest()
  expect((await catalog()).data).toMatchObject([
    { id: "deepseek-v4.1-flash" },
    { id: "group/custom", name: "My fallback" },
  ])
  await upsertRoutingGroup({ ...group, expose: false })
  expect((await catalog()).data.map((model) => model.id)).toEqual([
    "deepseek-v4.1-flash",
  ])
  expect(() =>
    validateGroup({ ...group, expose: "true" } as unknown as Parameters<
      typeof validateGroup
    >[0]),
  ).toThrow("expose must be a boolean")
})

test("exposed custom groups still respect user model permissions", async () => {
  connection("alpha", 60)
  await upsertRoutingGroup({
    id: "custom",
    name: "Custom",
    members: ["alpha/deepseek-v4.1-flash"],
    rules: [],
    expose: true,
  })
  const user: User = {
    id: "test",
    username: "test",
    hashedApiKey: "hash",
    role: "user",
    enabled: true,
    quotaLimit: 0,
    usedTokens: 0,
    createdAt: Date.now(),
    allowedModels: ["deepseek-v4.1-flash"],
  }
  expect((await catalog(user)).data.map((model) => model.id)).toEqual([
    "deepseek-v4.1-flash",
  ])
  user.allowedModels = ["group/custom"]
  expect((await catalog(user)).data.map((model) => model.id)).toEqual([
    "group/custom",
  ])
})
