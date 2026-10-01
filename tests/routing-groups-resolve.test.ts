/**
 * Routing-group resolution and the admin routing-group API.
 *
 * `resolveGroupMember` is pure, so the rule/fallback/suffix edges are pinned
 * directly. The router shares one JSON file with the store, so the endpoint
 * tests run against a temp data dir and cover the shapes the editor consumes:
 * list, upsert, validation rejection, delete, references and meta.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  clearRoutingGroupsCacheForTest,
  type RoutingGroup,
} from "~/lib/routing-groups"
import {
  groupModelReference,
  orderMembersForRouting,
  parseGroupReference,
  resolveGroupMember,
} from "~/lib/routing-groups/resolve"
import { routingGroupsApiRoutes } from "~/routes/admin/api/routing-groups"

const isolationRoot = PATHS.APP_DIR

/** Local noon, so time-window rules read the same in any zone. */
function localNoon(): Date {
  return new Date(2026, 5, 5, 12, 0)
}

function makeGroup(overrides: Partial<RoutingGroup> = {}): RoutingGroup {
  return {
    id: "main",
    name: "Main",
    members: ["openai/gpt-5", "openai/o3:high:fast"],
    rules: [],
    ...overrides,
  }
}

describe("resolveGroupMember", () => {
  test("a matching rule names the member and reports its index", () => {
    const group = makeGroup({
      rules: [
        // No conditions: never matches, so its index must be skipped.
        { use: "openai/o3" },
        { use: "openai/o3", tokens: 100_000 },
      ],
    })
    expect(
      resolveGroupMember(group, { tokens: 200_000, at: localNoon() }),
    ).toEqual({
      groupId: "main",
      member: "openai/o3",
      model: "openai/o3",
      fast: false,
      ruleIndex: 1,
    })
  })

  test("the first matching rule wins, not a later one", () => {
    const group = makeGroup({
      rules: [
        { use: "openai/gpt-5", intent: "code" },
        { use: "openai/o3", tokens: 10 },
      ],
    })
    expect(
      resolveGroupMember(group, {
        intent: "code",
        tokens: 1_000,
        at: localNoon(),
      }),
    ).toMatchObject({ member: "openai/gpt-5", ruleIndex: 0 })
  })

  test("falls back to pick, then to the first member, when no rule matches", () => {
    const picked = makeGroup({
      pick: "openai/o3",
      rules: [{ use: "openai/gpt-5", effort: "xhigh" }],
    })
    const resolved = resolveGroupMember(picked, {
      effort: "low",
      at: localNoon(),
    })
    expect(resolved?.member).toBe("openai/o3")
    expect(resolved?.ruleIndex).toBeUndefined()

    // No pick and no matching rule: the first member leads.
    expect(resolveGroupMember(makeGroup(), { at: localNoon() })).toMatchObject({
      member: "openai/gpt-5",
    })

    // Nothing to lead with at all still resolves to undefined.
    expect(
      resolveGroupMember(makeGroup({ members: [] }), { at: localNoon() }),
    ).toBeUndefined()
  })

  test("splits :effort and :fast off the chosen member", () => {
    expect(
      resolveGroupMember(makeGroup({ pick: "openai/o3:high:fast" }), {
        at: localNoon(),
      }),
    ).toEqual({
      groupId: "main",
      member: "openai/o3:high:fast",
      model: "openai/o3",
      effort: "high",
      fast: true,
    })

    expect(
      resolveGroupMember(makeGroup({ pick: "openai/gpt-5:fast" }), {
        at: localNoon(),
      }),
    ).toEqual({
      groupId: "main",
      member: "openai/gpt-5:fast",
      model: "openai/gpt-5",
      fast: true,
    })

    // An effort without :fast leaves the flag false.
    expect(
      resolveGroupMember(makeGroup({ pick: "openai/gpt-5:max" }), {
        at: localNoon(),
      }),
    ).toEqual({
      groupId: "main",
      member: "openai/gpt-5:max",
      model: "openai/gpt-5",
      effort: "max",
      fast: false,
    })
  })

  test("a known model keeps its own suffix", () => {
    const group = makeGroup({ pick: "vendor/model:fast" })
    expect(
      resolveGroupMember(
        group,
        { at: localNoon() },
        { knownModel: (id) => id === "vendor/model:fast" },
      ),
    ).toEqual({
      groupId: "main",
      member: "vendor/model:fast",
      model: "vendor/model:fast",
      fast: false,
    })
  })
})

describe("orderMembersForRouting", () => {
  const group = (overrides: Partial<RoutingGroup> = {}): RoutingGroup => ({
    id: "g",
    name: "G",
    members: ["a/m1", "b/m2", "c/m3"],
    rules: [],
    ...overrides,
  })

  test("order keeps the chosen member first, then the rest in order", () => {
    expect(orderMembersForRouting(group(), "b/m2")).toEqual([
      "b/m2",
      "a/m1",
      "c/m3",
    ])
  })

  test("a matching rule leads whatever the routing mode", () => {
    expect(
      orderMembersForRouting(group({ routing: "rotate" }), "b/m2", {
        ruleMatched: true,
        turnKey: "t",
      }),
    ).toEqual(["b/m2", "a/m1", "c/m3"])
  })

  test("manual keeps only the pick", () => {
    expect(
      orderMembersForRouting(
        group({ routing: "manual", pick: "c/m3" }),
        "a/m1",
      ),
    ).toEqual(["c/m3"])
  })

  test("rotate is stable for one turn and moves the head across turns", () => {
    const g = group({ routing: "rotate" })
    const once = orderMembersForRouting(g, "a/m1", { turnKey: "turn-1" })
    expect(orderMembersForRouting(g, "a/m1", { turnKey: "turn-1" })).toEqual(
      once,
    )
    expect(once).toHaveLength(3)
    // The lead is always a real member.
    expect(g.members).toContain(once[0]!)
  })

  test("smart / usage rank the members by allowance", () => {
    const reversed = (members: Array<string>) => [...members].reverse()
    expect(
      orderMembersForRouting(group({ routing: "smart" }), "a/m1", {
        rankByAllowance: reversed,
      }),
    ).toEqual(["c/m3", "b/m2", "a/m1"])
    expect(
      orderMembersForRouting(group({ routing: "usage" }), "a/m1", {
        rankByAllowance: reversed,
      }),
    ).toEqual(["c/m3", "b/m2", "a/m1"])
  })
})

describe("group references", () => {
  test("round-trips group/<id>", () => {
    expect(groupModelReference("lane")).toBe("group/lane")
    expect(parseGroupReference(groupModelReference("lane"))).toBe("lane")
    expect(parseGroupReference("  group/lane  ")).toBe("lane")
  })

  test("rejects anything that is not a group reference", () => {
    expect(parseGroupReference("group/")).toBeUndefined()
    expect(parseGroupReference("lane")).toBeUndefined()
    expect(parseGroupReference("")).toBeUndefined()
    expect(parseGroupReference("provider/model")).toBeUndefined()
  })
})

describe("routing-groups API", () => {
  const app = new Hono()
  app.route("/admin/api/routing-groups", routingGroupsApiRoutes)

  let testDir = isolationRoot

  beforeEach(async () => {
    clearRoutingGroupsCacheForTest()
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "routing-groups-api-test-"),
    )
    redirectPathsToDir(testDir)
  })

  afterAll(async () => {
    clearRoutingGroupsCacheForTest()
    redirectPathsToDir(isolationRoot)
    await fs
      .rm(testDir, { force: true, recursive: true })
      .catch(() => undefined)
  })

  /**
   * `pathname` is appended to the mount prefix as-is; the collection root is
   * `"/routing-groups"` itself, not `"/routing-groups/"` (Hono registers the
   * mounted `"/"` route without a trailing slash).
   */
  function api(pathname: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set("content-type", "application/json")
    return app.request(`http://localhost/admin/api/routing-groups${pathname}`, {
      ...init,
      headers,
    })
  }

  function upsert(group: RoutingGroup) {
    return api("", { method: "POST", body: JSON.stringify(group) })
  }

  async function list(): Promise<Array<RoutingGroup>> {
    const body = (await (await api("")).json()) as {
      groups: Array<RoutingGroup>
    }
    return body.groups
  }

  test("lists, upserts and reads back a group", async () => {
    const empty = await api("")
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ groups: [] })

    const created = await upsert(makeGroup())
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ group: makeGroup() })

    expect(await list()).toEqual([makeGroup()])

    const single = await api("/main")
    expect(single.status).toBe(200)
    expect(await single.json()).toEqual({ group: makeGroup() })

    const missing = await api("/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Group not found" })
  })

  test("rejects an invalid group with the validation message", async () => {
    const res = await upsert({ ...makeGroup(), name: "  " })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("name is required")

    // Nothing was written by the rejected call.
    expect(await list()).toEqual([])
  })

  test("deletes a group and 404s the second time", async () => {
    await upsert(makeGroup())

    const deleted = await api("/main", { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })

    const again = await api("/main", { method: "DELETE" })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: "Group not found" })
  })

  test("replaces the whole list", async () => {
    await upsert(makeGroup())

    const res = await api("", {
      method: "PUT",
      body: JSON.stringify({
        groups: [makeGroup({ id: "other", name: "Other" })],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [makeGroup({ id: "other", name: "Other" })],
    })
    expect((await list()).map((group) => group.id)).toEqual(["other"])

    const bad = await api("", { method: "PUT", body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: "groups must be an array" })
  })

  test("references the stored groups as selectable models", async () => {
    await upsert(makeGroup())

    const res = await api("/references")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      references: [{ id: "main", name: "Main", reference: "group/main" }],
    })
  })

  test("hands the editor its vocabulary", async () => {
    const res = await api("/meta")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      effortLevels: Array<string>
      memberEffortHelp: string
      days: Array<string>
    }
    expect(body.effortLevels).toContain("high")
    expect(body.days).toContain("mon")
    expect(body.memberEffortHelp).toContain(":fast")
  })
})
