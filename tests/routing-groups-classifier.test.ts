/**
 * The default intent classifier.
 *
 * The slot itself is a no-op until something fills it, and the default filler
 * asks a model — which a test must never do. So the model call sits behind a
 * seam: a stub answers, and the classifier's job (prompt in, one of the
 * group's intents out) is what gets pinned here. The last two tests then run
 * a `group/<id>` request through admission, first with a stub classifier
 * registered and then with none, because "an `intent` rule matches" and "an
 * `intent` rule must not match on its own" are the two behaviours the slot
 * exists for.
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
  type GroupDecisionInput,
} from "~/lib/request-admission"
import { getRequestLogContext, initRequestLog } from "~/lib/request-log"
import {
  classifyIntent,
  clearRoutingGroupsCacheForTest,
  hasIntentClassifier,
  registerIntentClassifier,
  resetIntentClassifierForTest,
  type IntentClassifierInput,
  type RoutingGroup,
  upsertRoutingGroup,
} from "~/lib/routing-groups"
import {
  createDefaultIntentClassifier,
  intentFromReply,
  resetIntentClassifierCompleterForTest,
  setIntentClassifierCompleterForTest,
} from "~/lib/routing-groups/classifier-default"

const INPUT: IntentClassifierInput = {
  text: "write me a parser",
  intents: ["code", "chat"],
  provider: "vendor",
  model: "small-model",
}

beforeEach(() => {
  resetIntentClassifierForTest()
  resetIntentClassifierCompleterForTest()
})

afterAll(() => {
  resetIntentClassifierForTest()
  resetIntentClassifierCompleterForTest()
})

describe("intentFromReply", () => {
  test("an exact label wins, then the first label the reply mentions", () => {
    expect(intentFromReply("code", ["chat", "code"])).toBe("code")
    expect(intentFromReply("The intent is code.", ["chat", "code"])).toBe(
      "code",
    )
    expect(intentFromReply('{"intent":"chat"}', ["chat", "code"])).toBe("chat")
    // Ties follow the caller's list, not the reply's word order.
    expect(intentFromReply("code and chat", ["chat", "code"])).toBe("chat")
  })

  test("a reply that names no intent is no intent", () => {
    expect(intentFromReply("", ["code"])).toBeUndefined()
    expect(intentFromReply("   ", ["code"])).toBeUndefined()
    expect(intentFromReply("banana", ["code", "chat"])).toBeUndefined()
    expect(intentFromReply("code", [])).toBeUndefined()
  })
})

describe("the default classifier", () => {
  test("a reply is mapped to one of the group's intents", async () => {
    const asked: Array<IntentClassifierInput> = []
    setIntentClassifierCompleterForTest(async (input) => {
      asked.push(input)
      return "Code."
    })

    // Nothing has registered a classifier: the slot installs the default
    // itself on the first ask.
    expect(hasIntentClassifier()).toBe(false)
    expect(await classifyIntent(INPUT)).toBe("code")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      text: INPUT.text,
      intents: ["code", "chat"],
      provider: "vendor",
      model: "small-model",
    })
    expect(hasIntentClassifier()).toBe(true)
  })

  test("an unparseable reply is no intent", async () => {
    registerIntentClassifier(createDefaultIntentClassifier())

    setIntentClassifierCompleterForTest(async () => "I am not sure.")
    expect(await classifyIntent(INPUT)).toBeUndefined()

    setIntentClassifierCompleterForTest(async () => "")
    expect(await classifyIntent(INPUT)).toBeUndefined()
  })

  test("a completer that throws never reaches the caller", async () => {
    registerIntentClassifier(createDefaultIntentClassifier())
    setIntentClassifierCompleterForTest(async () => {
      throw new Error("upstream down")
    })

    await expect(classifyIntent(INPUT)).resolves.toBeUndefined()
  })
})

// ── End to end, through admission ─────────────────────────────────

describe("an intent rule in admission", () => {
  const isolationRoot = PATHS.APP_DIR
  let testDir = isolationRoot

  beforeEach(async () => {
    clearRoutingGroupsCacheForTest()
    __resetProviderConnectionsForTest()
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-intent-"))
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

  /** The group: a code request goes to the large member, anything else to pick. */
  const group: RoutingGroup = {
    id: "lane",
    name: "Lane",
    members: ["vendor/large-model", "vendor/small-model"],
    rules: [{ use: "vendor/large-model", intent: "code" }],
    pick: "vendor/small-model",
    classifier: { provider: "vendor", model: "small-model" },
  }

  /** One plain connection serving both members. */
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
        {
          publicId: "vendor/small-model-2",
          upstreamId: "small-2",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    }
  }

  let pending: Partial<GroupDecisionInput> = {}

  const app = new Hono()
  app.onError((error) => {
    if (error instanceof HTTPError) return error.response
    throw error
  })
  app.post("/v1/chat/completions", async (c) => {
    initRequestLog(c)
    const admission = await prepareRequestAdmission(c, {
      routeKind: "reasoning",
      model: "group/lane",
      endpoint: "chat",
      messageContent: pending.messageContent,
      sessionPayload: {
        messages: [{ role: "user", content: pending.messageContent }],
      },
    })
    const entry = getRequestLogContext(c)?.entry
    return c.json({
      publicModelId: admission.target.publicModelId,
      groupDecision: entry?.failoverReason,
    })
  })

  async function admit(
    messageContent: string,
  ): Promise<{ publicModelId: string; groupDecision?: string }> {
    pending = { messageContent }
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST",
    })
    return (await response.json()) as {
      publicModelId: string
      groupDecision?: string
    }
  }

  test("a registered classifier answers and the rule matches", async () => {
    await upsertRoutingGroup(group)
    upsertProviderConnection(connection())

    const asked: Array<string> = []
    registerIntentClassifier({
      classify: async (input) => {
        asked.push(input.text)
        return "code"
      },
    })

    const body = await admit("write me a parser")
    expect(body).toMatchObject({
      publicModelId: "vendor/large-model",
      groupDecision: "routing-group:lane→vendor/large-model",
    })
    expect(asked).toEqual(["write me a parser"])
  })

  test("with no classifier registered the rule cannot match", async () => {
    await upsertRoutingGroup(group)
    upsertProviderConnection(connection())

    // Nothing registers a classifier here — that is the state a deployment
    // without one is in. The lazily-installed default is the only candidate,
    // and its completer is stubbed to answer nothing, so no intent is invented
    // and the rule cannot match.
    expect(hasIntentClassifier()).toBe(false)
    const asked: Array<string> = []
    setIntentClassifierCompleterForTest(async (input) => {
      asked.push(input.text)
      return ""
    })

    const body = await admit("write me a parser")
    expect(body.publicModelId).toBe("vendor/small-model")
    expect(asked).toEqual(["write me a parser"])
  })

  test("a group without a classifier target never asks", async () => {
    await upsertRoutingGroup({ ...group, classifier: undefined })
    upsertProviderConnection(connection())

    const asked: Array<string> = []
    setIntentClassifierCompleterForTest(async (input) => {
      asked.push(input.text)
      return "code"
    })

    const body = await admit("write me a parser")
    expect(body.publicModelId).toBe("vendor/small-model")
    expect(asked).toEqual([])
  })
})

describe("resolveGroupDecision intent resolution", () => {
  test("the classifier dep is used when the group names a target", async () => {
    const seen: Array<IntentClassifierInput> = []
    const decision = await resolveGroupDecision(
      { model: "group/lane", messageContent: "write me a parser" },
      {
        getGroup: async () => ({
          id: "lane",
          name: "Lane",
          members: ["vendor/large-model", "vendor/small-model"],
          rules: [{ use: "vendor/large-model", intent: "code" }],
          pick: "vendor/small-model",
          classifier: { provider: "vendor", model: "small-model" },
        }),
        classify: async (input) => {
          seen.push(input)
          return "code"
        },
      },
    )

    expect(decision).toMatchObject({
      member: "vendor/large-model",
      ruleIndex: 0,
    })
    expect(seen[0]?.provider).toBe("vendor")
  })
})
