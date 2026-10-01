/**
 * A group member's `:effort` / `:fast`, on the outgoing request.
 *
 * `member.ts` strips the suffixes off the member so the id can be routed; this
 * is the other half — writing them back as request fields, so a group that
 * names `vendor/model:high:fast` is actually served at high effort on the fast
 * lane. The unit tests pin the translation field by field, then a real
 * admission run pins it end to end: the request body every route hands to
 * dispatch is the body admission wrote on, and a request that is not a group
 * reference is left exactly as it arrived.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import { HTTPError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  type ProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { getRequestLogContext, initRequestLog } from "~/lib/request-log"
import {
  applyGroupOverrides,
  FAST_SERVICE_TIER,
} from "~/lib/routing-groups/apply"
import {
  clearRoutingGroupsCacheForTest,
  type RoutingGroup,
  upsertRoutingGroup,
} from "~/lib/routing-groups"

describe("applyGroupOverrides", () => {
  test("a `:high:fast` member applies both effort and fast", () => {
    const payload: Record<string, unknown> = {
      model: "vendor/large-model",
      messages: [{ role: "user", content: "hi" }],
    }

    const applied = applyGroupOverrides(
      payload,
      { effort: "high", fast: true },
      { endpoint: "chat" },
    )

    expect(payload["reasoning_effort"]).toBe("high")
    expect(payload["service_tier"]).toBe(FAST_SERVICE_TIER)
    expect(applied).toEqual({
      effort: "high",
      fast: true,
      effortField: "reasoning_effort",
      fastField: "service_tier",
    })
  })

  test("a plain member applies neither", () => {
    const payload: Record<string, unknown> = {
      model: "vendor/small-model",
      messages: [{ role: "user", content: "hi" }],
    }
    const before = structuredClone(payload)

    const applied = applyGroupOverrides(
      payload,
      { fast: false },
      {
        endpoint: "chat",
      },
    )

    expect(payload).toEqual(before)
    expect(applied).toEqual({ fast: false })
  })

  test("the responses wire takes `reasoning.effort` and keeps the rest", () => {
    const payload: Record<string, unknown> = {
      model: "vendor/large-model",
      input: [],
      reasoning: { summary: "auto" },
    }

    const applied = applyGroupOverrides(
      payload,
      { effort: "xhigh", fast: true },
      { endpoint: "responses" },
    )

    expect(payload["reasoning"]).toEqual({ summary: "auto", effort: "xhigh" })
    expect(payload["reasoning_effort"]).toBeUndefined()
    expect(payload["service_tier"]).toBe(FAST_SERVICE_TIER)
    expect(applied).toMatchObject({
      effort: "xhigh",
      effortField: "reasoning.effort",
      fast: true,
    })
  })

  test("a wire with no such field, or no payload, is left alone", () => {
    const gemini: Record<string, unknown> = { contents: [] }
    expect(
      applyGroupOverrides(
        gemini,
        { effort: "high", fast: true },
        {
          endpoint: "gemini",
        },
      ),
    ).toEqual({ fast: false })
    expect(gemini).toEqual({ contents: [] })

    expect(
      applyGroupOverrides(undefined, { effort: "high", fast: true }),
    ).toEqual({ fast: false })

    // A word that is not a level is not invented onto the payload.
    const payload: Record<string, unknown> = {}
    expect(
      applyGroupOverrides(payload, { effort: "turbo", fast: false }),
    ).toEqual({ fast: false })
    expect(payload).toEqual({})
  })
})

describe("group overrides reach the request through admission", () => {
  const isolationRoot = PATHS.APP_DIR
  let testDir = isolationRoot

  beforeEach(async () => {
    clearRoutingGroupsCacheForTest()
    __resetProviderConnectionsForTest()
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-apply-"))
    redirectPathsToDir(testDir)
  })

  afterAll(async () => {
    clearRoutingGroupsCacheForTest()
    __resetProviderConnectionsForTest()
    redirectPathsToDir(isolationRoot)
    await fs
      .rm(testDir, { force: true, recursive: true })
      .catch(() => undefined)
  })

  const group: RoutingGroup = {
    id: "lane",
    name: "Lane",
    members: ["vendor/large-model:high:fast", "vendor/small-model"],
    rules: [],
    pick: "vendor/large-model:high:fast",
  }

  function connection(): ProviderConnection {
    return {
      id: "lane-upstream",
      name: "Lane upstream",
      protocol: "openai-compatible",
      baseUrl: "https://upstream.test",
      enabled: true,
      priority: 10,
      weight: 1,
      createdAt: Date.now(),
      credentials: [
        {
          id: "lane-cred",
          authMode: "bearer",
          value: "sk-test",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
      models: [
        {
          publicId: "vendor/large-model",
          upstreamId: "large",
          endpoints: ["chat"],
          enabled: true,
        },
        {
          publicId: "vendor/small-model",
          upstreamId: "small",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    }
  }

  let pendingModel = "group/lane"

  const app = new Hono()
  app.onError((error) => {
    if (error instanceof HTTPError) return error.response
    throw error
  })
  app.post("/v1/chat/completions", async (c) => {
    initRequestLog(c)
    const sessionPayload: Record<string, unknown> = {
      model: pendingModel,
      messages: [{ role: "user", content: "hi" }],
    }
    const admission = await prepareRequestAdmission(c, {
      routeKind: "reasoning",
      model: pendingModel,
      endpoint: "chat",
      messageContent: "hi",
      sessionPayload,
    })
    const entry = getRequestLogContext(c)?.entry

    return c.json({
      sessionPayload,
      publicModelId: admission.target.publicModelId,
      group: admission.group?.member,
      groupOverrides: admission.groupOverrides,
      loggedEffort: entry?.reasoningEffort,
    })
  })

  async function admit(model: string) {
    pendingModel = model
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST",
    })
    return (await response.json()) as {
      sessionPayload: Record<string, unknown>
      publicModelId: string
      group?: string
      groupOverrides?: Record<string, unknown>
      loggedEffort?: string
    }
  }

  test("the member's effort and fast lane land on the outgoing payload", async () => {
    await upsertRoutingGroup(group)
    upsertProviderConnection(connection())

    const body = await admit("group/lane")

    expect(body.publicModelId).toBe("vendor/large-model")
    expect(body.group).toBe("vendor/large-model:high:fast")
    expect(body.groupOverrides).toEqual({
      effort: "high",
      fast: true,
      effortField: "reasoning_effort",
      fastField: "service_tier",
    })
    // The payload admission was handed is the payload the route dispatches.
    expect(body.sessionPayload).toMatchObject({
      reasoning_effort: "high",
      service_tier: "priority",
    })
    expect(body.loggedEffort).toBe("high")
  })

  test("a plain model reference leaves the payload untouched", async () => {
    await upsertRoutingGroup(group)
    upsertProviderConnection(connection())

    const body = await admit("vendor/small-model")

    expect(body.publicModelId).toBe("vendor/small-model")
    expect(body.group).toBeUndefined()
    expect(body.groupOverrides).toBeUndefined()
    expect(body.sessionPayload).toEqual({
      model: "vendor/small-model",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(body.loggedEffort).toBeUndefined()
  })
})
