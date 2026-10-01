/**
 * Auto-derived routing groups.
 *
 * A model two or more connections serve under the same name becomes a group,
 * derived on every read and never stored. The derivation is pure, so
 * `sameModel` / `slug` / `deriveAutoGroups` are pinned directly; the store and
 * the API are proved against a temp data dir with real connections, covering
 * the merge, the hide-on-delete and the restore.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  type ProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { selectGroupRouteTarget } from "~/lib/route-target"
import {
  clearRoutingGroupsCacheForTest,
  collectServedModels,
  deleteRoutingGroup,
  deriveAutoGroups,
  getRoutingGroup,
  groupReferenceFor,
  listRoutingGroups,
  listMemberOptions,
  restoreAutoGroup,
  routingGroupsPath,
  sameModel,
  slug,
  upsertRoutingGroup,
  type RoutingGroup,
  type ServedModel,
} from "~/lib/routing-groups"
import { routingGroupsApiRoutes } from "~/routes/admin/api/routing-groups"

// ── sameModel ─────────────────────────────────────────────────────

describe("sameModel", () => {
  test("folds the vendor prefix, version dots and the snapshot date", () => {
    expect(sameModel("claude-opus-5.5")).toBe("claude-opus-5-5")
    expect(sameModel("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5")
    expect(sameModel("Claude-Opus-5-5-20260801")).toBe("claude-opus-5-5")
    expect(sameModel("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek-v4-1-flash",
    )
  })

  test("leaves a variant after the colon apart, and a non-date tail alone", () => {
    expect(sameModel("vendor/model:batch")).toBe("model:batch")
    expect(sameModel("vendor/model:7b")).toBe("model:7b")
    // A tail that is not a YYYYMMDD date is kept.
    expect(sameModel("model-12345678")).toBe("model-12345678")
  })
})

describe("slug", () => {
  test("lower-cases and collapses every run of non-alphanumerics", () => {
    expect(slug("Claude Opus 5.5")).toBe("claude-opus-5-5")
    expect(slug("a/b:c")).toBe("a-b-c")
    expect(slug("  --x--  ")).toBe("x")
  })
})

// ── deriveAutoGroups ──────────────────────────────────────────────

describe("deriveAutoGroups", () => {
  function served(
    provider: string,
    modelId: string,
    name?: string,
  ): ServedModel {
    return {
      connectionId: `${provider}-conn`,
      provider,
      modelId,
      ...(name === undefined ? {} : { name }),
    }
  }

  test("a model two providers serve becomes one auto group", () => {
    const groups = deriveAutoGroups([
      served("copilot", "claude-opus-5.5", "Claude Opus 5.5"),
      served("anthropic", "claude-opus-5-5"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual({
      id: "auto-claude-opus-5-5",
      name: "Claude Opus 5.5",
      members: ["copilot/claude-opus-5.5", "anthropic/claude-opus-5-5"],
      rules: [],
      auto: true,
    })
  })

  test("a model only one provider serves is not a group", () => {
    expect(deriveAutoGroups([served("copilot", "gpt-5")])).toEqual([])
  })

  test("the same provider twice counts once, so it is not a group", () => {
    const groups = deriveAutoGroups([
      { connectionId: "a", provider: "copilot", modelId: "gpt-5" },
      { connectionId: "b", provider: "copilot", modelId: "gpt-5" },
    ])
    expect(groups).toEqual([])
  })

  test("keeps the order the models were first seen, one group each", () => {
    const groups = deriveAutoGroups([
      served("copilot", "gpt-5"),
      served("openai", "gpt-5"),
      served("copilot", "claude-opus-5.5"),
      served("anthropic", "claude-opus-5-5"),
    ])
    expect(groups.map((group) => group.id)).toEqual([
      "auto-gpt-5",
      "auto-claude-opus-5-5",
    ])
  })

  test("names the group after the vendor that names it, else the id", () => {
    const groups = deriveAutoGroups([
      served("copilot", "claude-opus-5.5"),
      served("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
    ])
    expect(groups[0]?.name).toBe("Claude Opus 5.5")
  })
})

// ── groupReferenceFor ─────────────────────────────────────────────

describe("groupReferenceFor", () => {
  const groups: Array<RoutingGroup> = [
    { id: "auto-claude-opus-5-5", name: "Opus", members: [], rules: [] },
  ]

  test("maps a bare model name to its group reference", () => {
    expect(groupReferenceFor("claude-opus-5.5", groups)).toBe(
      "group/auto-claude-opus-5-5",
    )
    expect(groupReferenceFor("Claude-Opus-5-5-20260801", groups)).toBe(
      "group/auto-claude-opus-5-5",
    )
  })

  test("an unknown model, an empty id or one with a provider resolves to nothing", () => {
    expect(groupReferenceFor("gpt-5", groups)).toBeUndefined()
    expect(groupReferenceFor("", groups)).toBeUndefined()
    expect(groupReferenceFor("copilot/claude-opus-5.5", groups)).toBeUndefined()
  })
})

// ── store + API ───────────────────────────────────────────────────

const isolationRoot = PATHS.APP_DIR

/** A plain connection serving the given public model ids. */
function connection(
  id: string,
  modelIds: Array<string>,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.test`,
    enabled: true,
    priority: 10,
    weight: 1,
    createdAt: Date.now(),
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "sk-test",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
    models: modelIds.map((publicId) => ({
      publicId,
      upstreamId: publicId,
      endpoints: ["chat"],
      enabled: true,
    })),
    ...overrides,
  }
}

describe("auto groups in the store and API", () => {
  const app = new Hono()
  app.route("/admin/api/routing-groups", routingGroupsApiRoutes)

  let testDir = isolationRoot

  beforeEach(async () => {
    clearRoutingGroupsCacheForTest()
    __resetProviderConnectionsForTest()
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-groups-auto-"))
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

  function api(pathname: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set("content-type", "application/json")
    return app.request(`http://localhost/admin/api/routing-groups${pathname}`, {
      ...init,
      headers,
    })
  }

  test("collectServedModels skips disabled connections, models and credentials", () => {
    upsertProviderConnection(connection("alpha", ["gpt-5"]))
    upsertProviderConnection(connection("beta", ["gpt-5"], { enabled: false }))
    upsertProviderConnection(
      connection("gamma", ["gpt-5"], {
        credentials: [
          {
            id: "gamma-cred",
            authMode: "bearer",
            value: "sk",
            enabled: false,
            status: "ready",
            createdAt: Date.now(),
          },
        ],
      }),
    )

    expect(collectServedModels().map((entry) => entry.connectionId)).toEqual([
      "alpha",
    ])
  })

  test("listMemberOptions lists pickable members, deduped by member string", () => {
    upsertProviderConnection(connection("alpha", ["gpt-5", "o3"]))
    upsertProviderConnection(connection("beta", ["gpt-5"]))
    expect(listMemberOptions().map((option) => option.member)).toEqual([
      "alpha/gpt-5",
      "alpha/o3",
      "beta/gpt-5",
    ])
  })

  test("listMemberOptions flags a free model, but not 'freedom'", () => {
    upsertProviderConnection(
      connection("alpha", ["vendor/model:free", "vendor/freedom-7b"]),
    )
    const options = listMemberOptions()
    expect(options.find((o) => o.member.includes(":free"))?.free).toBe(true)
    expect(
      options.find((o) => o.member.includes("freedom"))?.free,
    ).toBeUndefined()
  })

  test("selectGroupRouteTarget walks the members in order", () => {
    upsertProviderConnection(connection("alpha", ["model-a"]))
    upsertProviderConnection(connection("beta", ["model-b"]))
    const target = selectGroupRouteTarget(["alpha/model-a", "beta/model-b"], {
      endpoint: "chat",
    })
    expect(target?.connectionId).toBe("alpha")
  })

  test("selectGroupRouteTarget falls through to the next member", () => {
    // alpha has no connection at all, so the group must reach beta.
    upsertProviderConnection(connection("beta", ["model-b"]))
    const target = selectGroupRouteTarget(["alpha/model-a", "beta/model-b"], {
      endpoint: "chat",
    })
    expect(target?.connectionId).toBe("beta")
  })

  test("GET /models offers the members a picker can show", async () => {
    upsertProviderConnection(connection("alpha", ["gpt-5"]))
    const res = await api("/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { models: Array<{ member: string }> }
    expect(body.models.map((model) => model.member)).toEqual(["alpha/gpt-5"])
  })

  test("a legacy auto reference resolves without appearing in the group list", async () => {
    upsertProviderConnection(connection("alpha", ["claude-opus-5.5"]))
    upsertProviderConnection(connection("beta", ["claude-opus-5.5"]))

    const groups = await listRoutingGroups()
    expect(groups).toEqual([])

    // It is derived: nothing was written to disk (the file may not exist yet).
    const onDisk = await fs
      .readFile(routingGroupsPath(), "utf8")
      .catch(() => '{"groups":[]}')
    expect(
      (JSON.parse(onDisk) as { groups: Array<RoutingGroup> }).groups,
    ).toEqual([])

    // …and it resolves like any group.
    expect(await getRoutingGroup("auto-claude-opus-5-5")).toMatchObject({
      auto: true,
    })
  })

  test("a stored group of the same id shadows the derived one", async () => {
    upsertProviderConnection(connection("alpha", ["gpt-5"]))
    upsertProviderConnection(connection("beta", ["gpt-5"]))

    await upsertRoutingGroup({
      id: "auto-gpt-5",
      name: "My GPT-5",
      members: ["alpha/gpt-5"],
      rules: [],
    })

    const groups = await listRoutingGroups()
    expect(groups.map((group) => group.id)).toEqual(["auto-gpt-5"])
    expect(groups[0]?.name).toBe("My GPT-5")
    expect(groups[0]?.auto).toBeUndefined()
  })

  test("removing a derived group hides it, and it can be restored", async () => {
    upsertProviderConnection(connection("alpha", ["gpt-5"]))
    upsertProviderConnection(connection("beta", ["gpt-5"]))

    expect(await deleteRoutingGroup("auto-gpt-5")).toBe(true)
    expect(await listRoutingGroups()).toEqual([])
    expect(await getRoutingGroup("auto-gpt-5")).toBeUndefined()

    // The hidden record is what keeps it gone; it round-trips through disk.
    clearRoutingGroupsCacheForTest()
    expect(await listRoutingGroups()).toEqual([])

    expect(await restoreAutoGroup("auto-gpt-5")).toBe(true)
    expect(await listRoutingGroups()).toEqual([])
    expect(await getRoutingGroup("auto-gpt-5")).toMatchObject({
      routing: "smart",
    })

    // Restoring something not hidden, or unknown, is a no-op.
    expect(await restoreAutoGroup("auto-gpt-5")).toBe(false)
    expect(await restoreAutoGroup("auto-nope")).toBe(false)
  })

  test("GET /lookup does not direct a bare model into a synthetic group", async () => {
    upsertProviderConnection(connection("alpha", ["claude-opus-5.5"]))
    upsertProviderConnection(connection("beta", ["claude-opus-5.5"]))

    const hit = await api("/lookup?model=claude-opus-5.5")
    expect(hit.status).toBe(404)

    const miss = await api("/lookup?model=gpt-5")
    expect(miss.status).toBe(404)
  })

  test("DELETE hides a derived group and POST /:id/restore brings it back", async () => {
    upsertProviderConnection(connection("alpha", ["gpt-5"]))
    upsertProviderConnection(connection("beta", ["gpt-5"]))

    expect((await api("/auto-gpt-5", { method: "DELETE" })).status).toBe(200)
    const afterDelete = (await (await api("")).json()) as {
      groups: Array<RoutingGroup>
    }
    expect(afterDelete.groups).toEqual([])

    expect((await api("/auto-gpt-5/restore", { method: "POST" })).status).toBe(
      200,
    )
    const afterRestore = (await (await api("")).json()) as {
      groups: Array<RoutingGroup>
    }
    expect(afterRestore.groups).toEqual([])
    expect(await getRoutingGroup("auto-gpt-5")).toMatchObject({
      routing: "smart",
    })

    // Restoring again 404s — it is no longer hidden.
    expect((await api("/auto-gpt-5/restore", { method: "POST" })).status).toBe(
      404,
    )
  })
})
