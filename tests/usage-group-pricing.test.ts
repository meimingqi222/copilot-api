import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  __resetProviderConnectionsForTest,
  type ProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import {
  getRequestLogContext,
  initRequestLog,
  patchRequestLog,
} from "~/lib/request-log"
import { statsStore } from "~/lib/stats-store"
import { recordUsage } from "~/lib/usage"

const groupId = "group/auto-deepseek-v4-1-flash"
const actualModel = "deepseek-v4.1-flash"

function connection(id: string, publicId = actualModel): ProviderConnection {
  const conn: ProviderConnection = {
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: "https://example.test",
    enabled: true,
    priority: 10,
    createdAt: Date.now(),
    credentials: [
      {
        id: `${id}-cred`,
        value: "test",
        authMode: "bearer",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
    models: [
      { publicId, upstreamId: actualModel, endpoints: ["chat"], enabled: true },
    ],
  }
  upsertProviderConnection(conn)
  return conn
}

beforeEach(() => {
  __resetProviderConnectionsForTest()
  statsStore.clearUsageStatsForTest()
  statsStore.setModelPricing(actualModel, {
    promptPricePer1k: 0.01,
    completionPricePer1k: 0.02,
    cacheReadPricePer1k: 0.001,
    cacheWritePricePer1k: 0.005,
  })
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  statsStore.clearUsageStatsForTest()
})

async function record(options: {
  request?: string
  owner?: string
  upstream?: string
  selected?: string
}) {
  const owner = options.owner ?? "winner"
  const app = new Hono()
  app.get("/", (c) => {
    initRequestLog(c)
    const request = options.request ?? groupId
    c.set("model", request)
    patchRequestLog(c, {
      modelRequested: request,
      modelUpstream: options.upstream,
      connectionId: owner,
      credentialId: `${owner}-cred`,
      routingGroupId: "auto-deepseek-v4-1-flash",
      routingGroupSelectedMember: options.selected,
    })
    recordUsage({
      c,
      accountId: owner,
      model: request,
      promptTokens: 1000,
      completionTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 1000,
      totalTokens: 4000,
    })
    return c.json(getRequestLogContext(c)?.entry)
  })
  const log = (await (await app.request("http://localhost/")).json()) as {
    model?: string
    modelRequested?: string
  }
  const date = statsStore.getDateString()
  return { log, models: statsStore.getUsageStats(owner, date, date)[0]?.models }
}

describe("group usage pricing", () => {
  test("member fallback strips routing suffixes when the upstream model was omitted", async () => {
    connection("winner")
    const result = await record({ selected: `winner/${actualModel}:high:fast` })
    expect(result.models?.[actualModel]?.cost).toBeCloseTo(0.036)
  })

  test("plain requests retain their own model pricing instead of inheriting trace upstream pricing", async () => {
    connection("winner")
    statsStore.setModelPricing("plain-billing-model", {
      promptPricePer1k: 0.03,
      completionPricePer1k: 0.04,
    })
    const result = await record({
      request: "plain-billing-model",
      upstream: actualModel,
    })
    expect(result.models?.["plain-billing-model"]?.cost).toBeCloseTo(0.07)
  })

  test("explicit zero pricing on the public model is not replaced by upstream prices", async () => {
    connection("winner", "free-public-alias")
    statsStore.setModelPricing("free-public-alias", {
      promptPricePer1k: 0,
      completionPricePer1k: 0,
    })
    const result = await record({ upstream: actualModel })
    expect(result.models?.["free-public-alias"]?.cost).toBe(0)
  })

  test("multiple public mappings use the selected member's manual price", async () => {
    const conn = connection("winner", "another-public-alias")
    conn.models!.push({
      publicId: "selected-public-alias",
      upstreamId: actualModel,
      endpoints: ["chat"],
      enabled: true,
    })
    upsertProviderConnection(conn)
    statsStore.setModelPricing("selected-public-alias", {
      promptPricePer1k: 0.03,
      completionPricePer1k: 0.04,
    })
    const result = await record({
      upstream: actualModel,
      selected: "winner/selected-public-alias:high",
    })
    expect(result.models?.["selected-public-alias"]?.cost).toBeCloseTo(0.07)
  })
  test("group request charges the actual model and preserves the requested group in the trace", async () => {
    connection("winner")
    const result = await record({
      upstream: actualModel,
      selected: `winner/${actualModel}`,
    })
    expect(result.models?.[actualModel]?.cost).toBeCloseTo(0.036)
    expect(result.models).not.toHaveProperty(groupId)
    expect(result.log.modelRequested).toBe(groupId)
    expect(result.log.model).toBe(actualModel)
  })

  test("final upstream after failover determines pricing, rather than the initial member", async () => {
    connection("winner")
    const result = await record({
      upstream: actualModel,
      selected: "initial/unpriced-model",
    })
    expect(result.models?.[actualModel]?.cost).toBeCloseTo(0.036)
  })

  test("a renamed public model retains its manual pricing", async () => {
    connection("winner", "priced-public-alias")
    statsStore.setModelPricing("priced-public-alias", {
      promptPricePer1k: 0.03,
      completionPricePer1k: 0.04,
    })
    const result = await record({ upstream: actualModel })
    expect(result.models?.["priced-public-alias"]?.cost).toBeCloseTo(0.07)
  })

  test("upstream pricing remains a fallback when the public alias has no price", async () => {
    connection("winner", "unpriced-public-alias")
    const result = await record({ upstream: actualModel })
    expect(result.models?.["unpriced-public-alias"]?.cost).toBeCloseTo(0.036)
  })
})
