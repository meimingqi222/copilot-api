/**
 * `group/<id>` as a model reference, in the request path.
 *
 * `resolveGroupDecision` reads nothing but the group it is handed and the parts
 * of the request admission already has, so the rule / fallback / payload edges
 * are pinned directly against it. The wiring is then proved end to end: a group
 * is stored in a temp data dir, a request asks for it by reference, and
 * admission has to come back with the member the group chose — while a plain
 * model name keeps behaving exactly as it did before groups existed.
 *
 * The trace assertion goes through a real request-log context (`initRequestLog`)
 * rather than a mock, so the group decision is checked where an operator would
 * read it: `patchRequestLog` onto the entry the live trace projects.
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
import {
  prepareRequestAdmission,
  resolveGroupDecision,
  type GroupDecisionDeps,
  type GroupDecisionInput,
} from "~/lib/request-admission"
import { getRequestLogContext, initRequestLog } from "~/lib/request-log"
import {
  clearRoutingGroupsCacheForTest,
  type IntentClassifierInput,
  type RoutingGroup,
  upsertRoutingGroup,
} from "~/lib/routing-groups"

/** Local noon, so time-window rules read the same in any zone. */
const fixedNow = () => new Date(2026, 5, 5, 12, 0)

/** Four characters per token, so this clears a 1_000-token rule. */
const BIG_TEXT = "x".repeat(4_000)

/** A group whose first rule sends anything large to the large member. */
function makeGroup(overrides: Partial<RoutingGroup> = {}): RoutingGroup {
  return {
    id: "lane",
    name: "Lane",
    members: ["vendor/large-model", "vendor/small-model"],
    rules: [{ use: "vendor/large-model", tokens: 1_000 }],
    pick: "vendor/small-model",
    ...overrides,
  }
}

function decide(
  input: Partial<GroupDecisionInput> = {},
  group: RoutingGroup | undefined = makeGroup(),
  deps: GroupDecisionDeps = {},
): ReturnType<typeof resolveGroupDecision> {
  return resolveGroupDecision(
    { model: "group/lane", ...input },
    { getGroup: async () => group, now: fixedNow, ...deps },
  )
}

describe("resolveGroupDecision", () => {
  test("the first matching rule names the member; pick answers otherwise", async () => {
    await expect(decide({ messageContent: BIG_TEXT })).resolves.toEqual({
      groupId: "lane",
      member: "vendor/large-model",
      model: "vendor/large-model",
      fast: false,
      ruleIndex: 0,
    })

    const small = await decide({ messageContent: "hi" })
    expect(small).toMatchObject({ member: "vendor/small-model" })
    expect(small?.ruleIndex).toBeUndefined()
  })

  test("a non-group reference and an unknown group resolve to nothing", async () => {
    await expect(
      decide({ model: "vendor/small-model" }),
    ).resolves.toBeUndefined()
    await expect(decide({ model: "group/" })).resolves.toBeUndefined()
    await expect(
      resolveGroupDecision(
        { model: "group/missing" },
        { getGroup: async () => undefined, now: fixedNow },
      ),
    ).resolves.toBeUndefined()
  })

  test("a group with no rule match and no pick resolves to nothing", async () => {
    const group = makeGroup({ rules: [], pick: undefined })
    await expect(decide({}, group)).resolves.toBeUndefined()
  })

  test("the rule context is read off the request", async () => {
    const imageRule = makeGroup({
      rules: [{ use: "vendor/large-model", images: true }],
    })
    await expect(
      decide(
        {
          sessionPayload: {
            messages: [
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: "x" } }],
              },
            ],
          },
        },
        imageRule,
      ),
    ).resolves.toMatchObject({ member: "vendor/large-model" })
    await expect(
      decide(
        { sessionPayload: { messages: [{ content: "just text" }] } },
        imageRule,
      ),
    ).resolves.toMatchObject({ member: "vendor/small-model" })

    const effortRule = makeGroup({
      rules: [{ use: "vendor/large-model", effort: "high" }],
    })
    await expect(
      decide({ reasoningEffort: "high" }, effortRule),
    ).resolves.toMatchObject({ member: "vendor/large-model" })
    await expect(
      decide({ reasoningEffort: "low" }, effortRule),
    ).resolves.toMatchObject({ member: "vendor/small-model" })

    const compactRule = makeGroup({
      rules: [{ use: "vendor/large-model", compact: true }],
    })
    await expect(decide({ compact: true }, compactRule)).resolves.toMatchObject(
      { member: "vendor/large-model" },
    )
    await expect(decide({}, compactRule)).resolves.toMatchObject({
      member: "vendor/small-model",
    })

    // The resolved initiator wins over the payload's inference.
    const agentRule = makeGroup({
      rules: [{ use: "vendor/large-model", agents: ["agent"] }],
    })
    await expect(
      decide({ inferredInitiator: "user", initiator: "agent" }, agentRule),
    ).resolves.toMatchObject({ member: "vendor/large-model" })
    await expect(
      decide({ inferredInitiator: "user" }, agentRule),
    ).resolves.toMatchObject({ member: "vendor/small-model" })
  })

  test("the time window is checked against the decision's instant", async () => {
    const noonOnly = makeGroup({
      rules: [
        { use: "vendor/large-model", time: { from: "11:00", to: "13:00" } },
      ],
    })
    const eveningOnly = makeGroup({
      rules: [
        { use: "vendor/large-model", time: { from: "19:00", to: "21:00" } },
      ],
    })

    await expect(decide({}, noonOnly)).resolves.toMatchObject({
      member: "vendor/large-model",
    })
    await expect(decide({}, eveningOnly)).resolves.toMatchObject({
      member: "vendor/small-model",
    })
  })

  test("an intent is classified only when the group names a classifier", async () => {
    const asked: Array<IntentClassifierInput> = []
    const classify = async (input: IntentClassifierInput) => {
      asked.push(input)
      return "code"
    }

    const classified = makeGroup({
      classifier: { provider: "vendor", model: "small-model" },
      rules: [{ use: "vendor/large-model", intent: "code" }],
    })
    await expect(
      decide({ messageContent: "write a parser" }, classified, { classify }),
    ).resolves.toMatchObject({ member: "vendor/large-model", ruleIndex: 0 })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      text: "write a parser",
      intents: ["code"],
      provider: "vendor",
      model: "small-model",
    })

    // Without a classifier the rule cannot match — no intent is invented — and
    // nothing was asked.
    await expect(
      decide(
        { messageContent: "write a parser" },
        makeGroup({ rules: [{ use: "vendor/large-model", intent: "code" }] }),
        { classify },
      ),
    ).resolves.toMatchObject({ member: "vendor/small-model" })
    expect(asked).toHaveLength(1)
  })

  test("a member's :effort and :fast are split off the model", async () => {
    const suffixed = makeGroup({
      members: ["vendor/large-model:high:fast", "vendor/small-model"],
      rules: [],
      pick: "vendor/large-model:high:fast",
    })

    await expect(decide({}, suffixed)).resolves.toEqual({
      groupId: "lane",
      member: "vendor/large-model:high:fast",
      model: "vendor/large-model",
      effort: "high",
      fast: true,
    })
  })
})

describe("prepareRequestAdmission with group references", () => {
  const isolationRoot = PATHS.APP_DIR
  let testDir = isolationRoot

  beforeEach(async () => {
    clearRoutingGroupsCacheForTest()
    __resetProviderConnectionsForTest()
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "routing-groups-admission-"),
    )
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

  /** One plain connection serving both models the group can pick. */
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

  let pending = { model: "group/lane", messageContent: BIG_TEXT }

  const app = new Hono()
  app.onError((error) => {
    if (error instanceof HTTPError) return error.response
    throw error
  })
  app.post("/v1/chat/completions", async (c) => {
    initRequestLog(c)
    const admission = await prepareRequestAdmission(c, {
      routeKind: "reasoning",
      model: pending.model,
      endpoint: "chat",
      messageContent: pending.messageContent,
      sessionPayload: {
        messages: [{ role: "user", content: pending.messageContent }],
      },
    })
    const entry = getRequestLogContext(c)?.entry

    return c.json({
      publicModelId: admission.target.publicModelId,
      upstreamModelId: admission.target.upstreamModelId,
      modelRequested: entry?.modelRequested,
      groupDecision: entry?.failoverReason,
    })
  })

  function admit(model: string, messageContent: string) {
    pending = { model, messageContent }
    return app.request("http://localhost/v1/chat/completions", {
      method: "POST",
    })
  }

  /** The admission result the test route reports back, as JSON. */
  interface AdmittedBody {
    publicModelId: string
    upstreamModelId: string
    modelRequested?: string
    groupDecision?: string
  }

  async function admitBody(
    model: string,
    messageContent: string,
  ): Promise<AdmittedBody> {
    return (await (await admit(model, messageContent)).json()) as AdmittedBody
  }

  test("a large request follows the rule's member", async () => {
    await upsertRoutingGroup(makeGroup())
    upsertProviderConnection(connection())

    const body = await admitBody("group/lane", BIG_TEXT)
    expect(body).toMatchObject({
      publicModelId: "vendor/large-model",
      upstreamModelId: "large",
      // The group reference stays the requested model; the member it chose is
      // what the trace reports as the reason the route moved.
      modelRequested: "group/lane",
      groupDecision: "routing-group:lane→vendor/large-model",
    })
  })

  test("a small request falls back to the group's pick", async () => {
    await upsertRoutingGroup(makeGroup())
    upsertProviderConnection(connection())

    const body = await admitBody("group/lane", "hi")
    expect(body).toMatchObject({
      publicModelId: "vendor/small-model",
      modelRequested: "group/lane",
      groupDecision: "routing-group:lane→vendor/small-model",
    })
  })

  test("a plain model is unaffected by a stored group", async () => {
    await upsertRoutingGroup(makeGroup())
    upsertProviderConnection(connection())

    const body = await admitBody("vendor/small-model", BIG_TEXT)
    expect(body).toMatchObject({
      publicModelId: "vendor/small-model",
      modelRequested: "vendor/small-model",
    })
    expect(body.groupDecision).toBeUndefined()
  })

  test("an unknown group is still just an unroutable model", async () => {
    await upsertRoutingGroup(makeGroup())
    upsertProviderConnection(connection())

    const response = await admit("group/nope", BIG_TEXT)
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('model "group/nope"')
  })
})
