/**
 * Routing groups: parsing, rule evaluation, the classifier slot and the store.
 *
 * The subsystem is pure text handling plus one JSON file, so these tests pin
 * the parsing edges that a hand-written group runs into — a model whose own id
 * ends in `:free`, a window that crosses midnight, an effort rule that must not
 * match a request with no reasoning at all — rather than internal structure.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  clearRoutingGroupsCacheForTest,
  cleanMember,
  classifyIntent,
  DAY_NAMES,
  daysText,
  deleteRoutingGroup,
  EFFORT_LEVELS,
  firstMatch,
  getRoutingGroup,
  hasIntentClassifier,
  holds,
  isNestedGroupMember,
  listRoutingGroups,
  memberEffort,
  memberFast,
  nestedGroupId,
  normalizeMember,
  normalizeWindow,
  parseDay,
  parseTime,
  registerIntentClassifier,
  replaceRoutingGroups,
  resetIntentClassifierForTest,
  RoutingGroupValidationError,
  routingGroupsPath,
  ruleMatches,
  TimeWindowError,
  upsertRoutingGroup,
  validateGroup,
  validateRoutingGroups,
  windowText,
  withMemberEffort,
  type RoutingGroup,
  type RuleContext,
} from "~/lib/routing-groups"

// ── Time windows ──────────────────────────────────────────────────

/** Local-time date, so the day/weekday assertions hold in any zone. */
function local(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
): Date {
  return new Date(year, month - 1, day, hours, minutes)
}

describe("time windows", () => {
  test("parses HH:MM and H:MM, rejecting out-of-range values", () => {
    expect(parseTime("09:30")).toBe(570)
    expect(parseTime("9:30")).toBe(570)
    expect(parseTime("00:00")).toBe(0)
    expect(parseTime("23:59")).toBe(1439)
    expect(parseTime("24:00")).toBeUndefined()
    expect(parseTime("10:60")).toBeUndefined()
    expect(parseTime("9.30")).toBeUndefined()
    expect(parseTime("")).toBeUndefined()
  })

  test("parses short and long day names", () => {
    expect(parseDay("mon")).toBe("mon")
    expect(parseDay("Monday")).toBe("mon")
    expect(parseDay("THURS")).toBe("thu")
    expect(parseDay("sunday")).toBe("sun")
    expect(parseDay("funday")).toBeUndefined()
    expect(parseDay("")).toBeUndefined()
  })

  test("a same-day window holds inside its range and at neither end", () => {
    const window = { from: "09:00", to: "17:00" }
    expect(holds(window, local(2026, 6, 5, 9, 0))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 12, 30))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 16, 59))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 8, 59))).toBe(false)
    expect(holds(window, local(2026, 6, 5, 17, 0))).toBe(false)
  })

  test("from === to is the whole day", () => {
    const window = { from: "00:00", to: "00:00" }
    expect(holds(window, local(2026, 6, 5, 0, 0))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 3, 17))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 23, 59))).toBe(true)
    // Any other pair is not a whole day, even one minute apart.
    expect(
      holds({ from: "22:00", to: "22:00" }, local(2026, 6, 5, 12, 0)),
    ).toBe(true)
  })

  test("a past-midnight window covers the next day's early hours", () => {
    // Friday 22:00 → Saturday 08:00.
    const window = { from: "22:00", to: "08:00" }
    expect(holds(window, local(2026, 6, 5, 22, 0))).toBe(true)
    expect(holds(window, local(2026, 6, 5, 23, 59))).toBe(true)
    expect(holds(window, local(2026, 6, 6, 0, 30))).toBe(true)
    expect(holds(window, local(2026, 6, 6, 7, 59))).toBe(true)
    expect(holds(window, local(2026, 6, 6, 8, 0))).toBe(false)
    expect(holds(window, local(2026, 6, 6, 12, 0))).toBe(false)
    expect(holds(window, local(2026, 6, 5, 21, 59))).toBe(false)
  })

  test("the small hours after midnight belong to the day the window opened on", () => {
    const friday = { from: "22:00", to: "08:00", days: ["fri"] }
    expect(holds(friday, local(2026, 6, 5, 23, 0))).toBe(true)
    expect(holds(friday, local(2026, 6, 6, 5, 0))).toBe(true)
    expect(holds(friday, local(2026, 6, 6, 23, 0))).toBe(false)

    const saturday = { from: "22:00", to: "08:00", days: ["sat"] }
    expect(holds(saturday, local(2026, 6, 6, 5, 0))).toBe(false)
    expect(holds(saturday, local(2026, 6, 6, 23, 0))).toBe(true)
    expect(holds(saturday, local(2026, 6, 7, 5, 0))).toBe(true)
  })

  test("day lists filter same-day and whole-day windows too", () => {
    const weekend = { from: "00:00", to: "00:00", days: ["sat", "sun"] }
    expect(holds(weekend, local(2026, 6, 6, 12, 0))).toBe(true)
    expect(holds(weekend, local(2026, 6, 7, 12, 0))).toBe(true)
    expect(holds(weekend, local(2026, 6, 5, 12, 0))).toBe(false)

    const weekdayHours = { from: "09:00", to: "17:00", days: ["Monday", "FRI"] }
    expect(holds(weekdayHours, local(2026, 6, 1, 10, 0))).toBe(true)
    expect(holds(weekdayHours, local(2026, 6, 5, 10, 0))).toBe(true)
    expect(holds(weekdayHours, local(2026, 6, 6, 10, 0))).toBe(false)
  })

  test("an unparsable window never holds", () => {
    expect(
      holds({ from: "25:00", to: "08:00" }, local(2026, 6, 5, 10, 0)),
    ).toBe(false)
    expect(holds({ from: "22:00", to: "8:0" }, local(2026, 6, 5, 23, 0))).toBe(
      false,
    )
    expect(
      holds({ from: "22:00", to: "08:00", days: [] }, local(2026, 6, 5, 23, 0)),
    ).toBe(false)
  })

  test("normalizeWindow reports what is wrong", () => {
    expect(() => normalizeWindow({ from: "9am", to: "10:00" })).toThrow(
      TimeWindowError,
    )
    expect(() =>
      normalizeWindow({ from: "09:00", to: "10:00", days: ["noday"] }),
    ).toThrow("Invalid window day")
    const normalized = normalizeWindow({ from: "22:00", to: "08:00" })
    expect(normalized.from).toBe(1320)
    expect(normalized.to).toBe(480)
    expect(normalized.wholeDay).toBe(false)
  })

  test("daysText compacts runs, wrapping the week", () => {
    expect(daysText({ from: "09:00", to: "17:00" })).toBe("Every day")
    expect(daysText({ from: "09:00", to: "17:00", days: [...DAY_NAMES] })).toBe(
      "Every day",
    )
    expect(
      daysText({
        from: "09:00",
        to: "17:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
      }),
    ).toBe("Mon–Fri")
    expect(daysText({ from: "09:00", to: "17:00", days: ["sat", "sun"] })).toBe(
      "Sat–Sun",
    )
    expect(daysText({ from: "09:00", to: "17:00", days: ["mon", "wed"] })).toBe(
      "Mon, Wed",
    )
    expect(
      daysText({ from: "09:00", to: "17:00", days: ["sun", "mon", "sat"] }),
    ).toBe("Sat–Mon")
    expect(daysText({ from: "22:00", to: "08:00", days: ["fri"] })).toBe("Fri")
  })

  test("windowText renders the whole window", () => {
    expect(
      windowText({ from: "22:00", to: "8:00", days: ["mon", "tue"] }),
    ).toBe("Mon–Tue 22:00–08:00")
    expect(windowText({ from: "00:00", to: "00:00" })).toBe("Every day All day")
  })
})

// ── Members ───────────────────────────────────────────────────────

describe("member suffixes", () => {
  test("splits a trailing known effort", () => {
    expect(memberEffort("openai/gpt-5:high")).toEqual({
      model: "openai/gpt-5",
      effort: "high",
    })
    expect(memberEffort("openai/gpt-5:XHIGH")).toEqual({
      model: "openai/gpt-5",
      effort: "xhigh",
    })
    for (const level of EFFORT_LEVELS) {
      expect(memberEffort(`provider/model:${level}`)?.effort).toBe(level)
    }
  })

  test("splits a trailing fast flag", () => {
    expect(memberFast("openai/gpt-5:fast")).toEqual({
      model: "openai/gpt-5",
      fast: true,
    })
    expect(memberFast("openai/gpt-5:high:fast")).toEqual({
      model: "openai/gpt-5:high",
      fast: true,
    })
    expect(memberFast("openai/gpt-5:high")).toBeUndefined()
  })

  test("a model's own suffix is not an effort", () => {
    // `:free` is part of the model id, not a member suffix.
    expect(memberEffort("deepseek/deepseek-r1:free")).toBeUndefined()
    expect(cleanMember("deepseek/deepseek-r1:free")).toBe(
      "deepseek/deepseek-r1:free",
    )
    expect(normalizeMember("deepseek/deepseek-r1:free")).toBe(
      "deepseek/deepseek-r1:free",
    )

    for (const id of [
      "provider/model:7b",
      "provider/model:0",
      "provider/model:32b",
      "provider/model:latest",
    ]) {
      expect(memberEffort(id)).toBeUndefined()
      expect(memberFast(id)).toBeUndefined()
      expect(cleanMember(id)).toBe(id)
    }
  })

  test("a real model keeps its own suffix when the catalog knows it", () => {
    const isKnownModel = (id: string) => id === "vendor/model:fast"
    expect(memberFast("vendor/model:fast", isKnownModel)).toBeUndefined()
    expect(memberEffort("vendor/model:fast", isKnownModel)).toBeUndefined()
    expect(cleanMember("vendor/model:fast", isKnownModel)).toBe(
      "vendor/model:fast",
    )
    // Anything else still splits.
    expect(memberEffort("vendor/model:high", isKnownModel)?.effort).toBe("high")
  })

  test("a bare model id without a provider is left alone", () => {
    // The structural rule: what is left must still be `provider/model` shaped.
    expect(memberEffort("gpt-5:high")).toBeUndefined()
    expect(memberEffort("/model:high")).toBeUndefined()
    expect(memberEffort("provider/:high")).toBeUndefined()
  })

  test("cleanMember strips both suffixes and trims", () => {
    expect(cleanMember("  openai/gpt-5:high:fast  ")).toBe("openai/gpt-5")
    expect(cleanMember("openai/gpt-5:fast")).toBe("openai/gpt-5")
    expect(cleanMember("openai/gpt-5:high")).toBe("openai/gpt-5")
    // Each suffix is taken at most once, whatever order they were written in.
    expect(cleanMember("openai/gpt-5:fast:high")).toBe("openai/gpt-5")
    expect(cleanMember("openai/gpt-5:high:high")).toBe("openai/gpt-5:high")
    expect(cleanMember("openai/gpt-5:fast:fast")).toBe("openai/gpt-5:fast")
    expect(cleanMember("openai/gpt-5")).toBe("openai/gpt-5")
  })

  test("normalizeMember canonicalizes suffix spelling and order", () => {
    expect(normalizeMember("openai/gpt-5:High:FAST")).toBe(
      "openai/gpt-5:high:fast",
    )
    expect(normalizeMember("openai/gpt-5:high")).toBe("openai/gpt-5:high")
    expect(normalizeMember("  openai/gpt-5  ")).toBe("openai/gpt-5")
  })

  test("withMemberEffort keeps :fast last and can clear the effort", () => {
    expect(withMemberEffort("openai/gpt-5", "high")).toBe("openai/gpt-5:high")
    expect(withMemberEffort("openai/gpt-5:low", "high")).toBe(
      "openai/gpt-5:high",
    )
    expect(withMemberEffort("openai/gpt-5:fast", "high")).toBe(
      "openai/gpt-5:high:fast",
    )
    expect(withMemberEffort("openai/gpt-5:high:fast", "max")).toBe(
      "openai/gpt-5:max:fast",
    )
    expect(withMemberEffort("openai/gpt-5:high:fast", "")).toBe(
      "openai/gpt-5:fast",
    )
    expect(withMemberEffort("openai/gpt-5:high", "off")).toBe("openai/gpt-5")
    expect(withMemberEffort("deepseek/deepseek-r1:free", "high")).toBe(
      "deepseek/deepseek-r1:free:high",
    )
    expect(() => withMemberEffort("openai/gpt-5", "turbo")).toThrow(
      "Unknown reasoning effort",
    )
  })

  test("nested group members are recognized without their own suffixes", () => {
    expect(isNestedGroupMember("group/fast-lane")).toBe(true)
    expect(isNestedGroupMember("openai/gpt-5")).toBe(false)
    expect(nestedGroupId("group/fast-lane")).toBe("fast-lane")
    expect(nestedGroupId("group/fast-lane:high")).toBe("fast-lane")
    expect(nestedGroupId("group/")).toBeUndefined()
    expect(nestedGroupId("openai/gpt-5")).toBeUndefined()
  })
})

// ── Rules ─────────────────────────────────────────────────────────

const NOON_FRIDAY = local(2026, 6, 5, 12, 0)

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return { at: NOON_FRIDAY, ...overrides }
}

describe("rule matching", () => {
  test("a rule with no conditions never matches", () => {
    expect(ruleMatches({ use: "openai/gpt-5" }, context())).toBe(false)
    expect(ruleMatches({ use: "openai/gpt-5", agents: [] }, context())).toBe(
      false,
    )
  })

  test("tokens is a lower bound", () => {
    const rule = { use: "openai/gpt-5", tokens: 100_000 }
    expect(ruleMatches(rule, context({ tokens: 100_000 }))).toBe(true)
    expect(ruleMatches(rule, context({ tokens: 250_000 }))).toBe(true)
    expect(ruleMatches(rule, context({ tokens: 99_999 }))).toBe(false)
    expect(ruleMatches(rule, context())).toBe(false)
  })

  test("images and compact compare against their own value", () => {
    expect(
      ruleMatches({ use: "m", images: true }, context({ images: true })),
    ).toBe(true)
    expect(
      ruleMatches({ use: "m", images: true }, context({ images: false })),
    ).toBe(false)
    expect(ruleMatches({ use: "m", images: false }, context({}))).toBe(true)
    expect(
      ruleMatches({ use: "m", compact: true }, context({ compact: true })),
    ).toBe(true)
    expect(
      ruleMatches({ use: "m", compact: false }, context({ compact: true })),
    ).toBe(false)
  })

  test("effort requires at least the rule's level", () => {
    const high = { use: "m", effort: "high" as const }
    expect(ruleMatches(high, context({ effort: "high" }))).toBe(true)
    expect(ruleMatches(high, context({ effort: "xhigh" }))).toBe(true)
    expect(ruleMatches(high, context({ effort: "max" }))).toBe(true)
    expect(ruleMatches(high, context({ effort: "medium" }))).toBe(false)
    expect(ruleMatches(high, context({ effort: "off" }))).toBe(false)
    expect(ruleMatches(high, context())).toBe(false)

    const low = { use: "m", effort: "low" as const }
    expect(ruleMatches(low, context({ effort: "low" }))).toBe(true)
    expect(ruleMatches(low, context({ effort: "max" }))).toBe(true)
  })

  test("an `on` rule and an `on` request meet in the middle", () => {
    const any = { use: "m", effort: "on" as const }
    expect(ruleMatches(any, context({ effort: "low" }))).toBe(true)
    expect(ruleMatches(any, context({ effort: "max" }))).toBe(true)
    expect(ruleMatches(any, context({ effort: "auto" }))).toBe(true)
    expect(ruleMatches(any, context({ effort: "off" }))).toBe(false)
    expect(ruleMatches(any, context())).toBe(false)

    const high = { use: "m", effort: "high" as const }
    // The request asked for reasoning without naming a level: it does not
    // contradict the rule, so the rule still applies.
    expect(ruleMatches(high, context({ effort: "on" }))).toBe(true)
    expect(ruleMatches(high, context({ effort: "auto" }))).toBe(true)
  })

  test("agents matches one of its names", () => {
    const rule = { use: "m", agents: ["codex", "amp"] }
    expect(ruleMatches(rule, context({ agent: "codex" }))).toBe(true)
    expect(ruleMatches(rule, context({ agent: "amp" }))).toBe(true)
    expect(ruleMatches(rule, context({ agent: "cursor" }))).toBe(false)
    expect(ruleMatches(rule, context())).toBe(false)
  })

  test("intent must equal what the classifier reported", () => {
    const rule = { use: "m", intent: "code" }
    expect(ruleMatches(rule, context({ intent: "code" }))).toBe(true)
    expect(ruleMatches(rule, context({ intent: "chat" }))).toBe(false)
    expect(ruleMatches(rule, context())).toBe(false)
  })

  test("time checks the window at ctx.at", () => {
    const rule = {
      use: "m",
      time: { from: "20:00", to: "23:00", days: ["fri"] },
    }
    expect(ruleMatches(rule, context({ at: local(2026, 6, 5, 21, 0) }))).toBe(
      true,
    )
    expect(ruleMatches(rule, context({ at: local(2026, 6, 5, 19, 0) }))).toBe(
      false,
    )
    expect(ruleMatches(rule, context({ at: local(2026, 6, 6, 21, 0) }))).toBe(
      false,
    )
  })

  test("conditions are ANDed", () => {
    const rule = {
      use: "openai/gpt-5:high",
      tokens: 50_000,
      images: true,
      effort: "medium" as const,
      agents: ["codex"],
      intent: "code",
      compact: false,
      time: {
        from: "09:00",
        to: "17:00",
        days: ["mon", "tue", "wed", "thu", "fri"],
      },
    }
    const full = context({
      tokens: 120_000,
      images: true,
      effort: "high",
      agent: "codex",
      intent: "code",
      compact: false,
    })
    expect(ruleMatches(rule, full)).toBe(true)

    for (const broken of [
      { ...full, tokens: 10 },
      { ...full, images: false },
      { ...full, effort: "low" },
      { ...full, agent: "other" },
      { ...full, intent: "chat" },
      { ...full, compact: true },
      { ...full, at: local(2026, 6, 6, 12, 0) },
    ] satisfies Array<RuleContext>) {
      expect(ruleMatches(rule, broken)).toBe(false)
    }
  })

  test("firstMatch wins by rule order, then falls back to pick", () => {
    const group: RoutingGroup = {
      id: "main",
      name: "Main",
      members: ["openai/gpt-5", "openai/gpt-5:fast", "vendor/model-b"],
      pick: "openai/gpt-5",
      rules: [
        { use: "no-such-member", tokens: 1_000_000 },
        { use: "openai/gpt-5:fast", images: true },
        { use: "vendor/model-b", effort: "high" },
      ],
    }
    expect(firstMatch(group, context({ images: true }))).toBe(
      "openai/gpt-5:fast",
    )
    expect(firstMatch(group, context({ effort: "max" }))).toBe("vendor/model-b")
    expect(firstMatch(group, context({ tokens: 10 }))).toBe("openai/gpt-5")
  })

  test("firstMatch returns undefined when there is no rule and no pick", () => {
    const group: RoutingGroup = {
      id: "bare",
      name: "Bare",
      members: ["openai/gpt-5"],
      rules: [{ use: "openai/gpt-5", tokens: 10_000 }],
    }
    expect(firstMatch(group, context({ tokens: 5 }))).toBeUndefined()
    expect(firstMatch(group, context({ tokens: 20_000 }))).toBe("openai/gpt-5")

    const noRules: RoutingGroup = {
      id: "empty",
      name: "Empty",
      members: [],
      rules: [],
    }
    expect(firstMatch(noRules, context())).toBeUndefined()
  })
})

// ── Classifier slot ───────────────────────────────────────────────

describe("classifier slot", () => {
  const input = {
    text: "write me a function",
    intents: ["code", "chat"],
    provider: "openai",
    model: "classifier-small",
  }

  beforeEach(() => {
    resetIntentClassifierForTest()
  })

  test("with nothing registered, classification is a no-op", async () => {
    expect(hasIntentClassifier()).toBe(false)
    expect(await classifyIntent(input)).toBeUndefined()
  })

  test("a registered classifier is used and reset clears it", async () => {
    let seen: string | undefined
    registerIntentClassifier({
      classify: async (received) => {
        seen = received.text
        return "code"
      },
    })
    expect(hasIntentClassifier()).toBe(true)
    expect(await classifyIntent(input)).toBe("code")
    expect(seen).toBe("write me a function")

    resetIntentClassifierForTest()
    expect(hasIntentClassifier()).toBe(false)
    expect(await classifyIntent(input)).toBeUndefined()
  })

  test("a failing or empty answer degrades to undefined", async () => {
    registerIntentClassifier({
      classify: async () => {
        throw new Error("upstream down")
      },
    })
    expect(await classifyIntent(input)).toBeUndefined()

    registerIntentClassifier({ classify: async () => "   " })
    expect(await classifyIntent(input)).toBeUndefined()

    registerIntentClassifier({ classify: async () => "code" })
    expect(await classifyIntent({ ...input, intents: [] })).toBeUndefined()

    const controller = new AbortController()
    controller.abort()
    expect(await classifyIntent(input, controller.signal)).toBeUndefined()
  })
})

// ── Store ─────────────────────────────────────────────────────────

describe("group store", () => {
  const isolationRoot = PATHS.APP_DIR
  let testDir = isolationRoot

  const baseGroup = (
    id: string,
    members: Array<string> = ["openai/gpt-5"],
  ): RoutingGroup => ({
    id,
    name: `Group ${id}`,
    members,
    rules: [],
  })

  beforeEach(async () => {
    resetIntentClassifierForTest()
    clearRoutingGroupsCacheForTest()
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-groups-test-"))
    redirectPathsToDir(testDir)
  })

  afterAll(() => {
    clearRoutingGroupsCacheForTest()
    redirectPathsToDir(isolationRoot)
  })

  test("writes, reads back and deletes inside the data dir", async () => {
    expect(await listRoutingGroups()).toEqual([])

    const stored = await upsertRoutingGroup(
      baseGroup("main", [
        "openai/gpt-5:high:fast",
        "deepseek/deepseek-r1:free",
      ]),
    )
    expect(stored.id).toBe("main")
    expect(stored.members).toEqual([
      "openai/gpt-5:high:fast",
      "deepseek/deepseek-r1:free",
    ])

    const onDisk = JSON.parse(
      await fs.readFile(routingGroupsPath(), "utf8"),
    ) as {
      groups: Array<RoutingGroup>
    }
    expect(onDisk.groups).toHaveLength(1)
    expect(onDisk.groups[0]?.members).toEqual(stored.members)

    // Round-trips through disk, not just the cache.
    clearRoutingGroupsCacheForTest()
    expect(await getRoutingGroup("main")).toEqual(stored)
    expect((await listRoutingGroups()).map((group) => group.id)).toEqual([
      "main",
    ])

    expect(await deleteRoutingGroup("main")).toBe(true)
    clearRoutingGroupsCacheForTest()
    expect(await listRoutingGroups()).toEqual([])
    expect(await deleteRoutingGroup("main")).toBe(false)
  })

  test("upsert replaces in place, replace rewrites the whole list", async () => {
    await upsertRoutingGroup(baseGroup("a"))
    await upsertRoutingGroup(baseGroup("b"))
    await upsertRoutingGroup({ ...baseGroup("a"), name: "Renamed" })

    let groups = await listRoutingGroups()
    expect(groups.map((group) => group.id)).toEqual(["a", "b"])
    expect(groups[0]?.name).toBe("Renamed")

    await replaceRoutingGroups([baseGroup("c"), baseGroup("d", ["openai/o3"])])
    clearRoutingGroupsCacheForTest()
    groups = await listRoutingGroups()
    expect(groups.map((group) => group.id)).toEqual(["c", "d"])
    expect(await getRoutingGroup("a")).toBeUndefined()
  })

  test("mutations reject a group that breaks the contract", async () => {
    await expect(
      upsertRoutingGroup(baseGroup("", ["openai/gpt-5"])),
    ).rejects.toThrow(RoutingGroupValidationError)
    await expect(
      upsertRoutingGroup({ ...baseGroup("a"), name: "  " }),
    ).rejects.toThrow("name is required")
    await expect(
      upsertRoutingGroup({
        ...baseGroup("a"),
        rules: [{ use: "openai/gpt-5", effort: "turbo" as never }],
      }),
    ).rejects.toThrow("effort is not a known effort level")
    await expect(
      upsertRoutingGroup({
        ...baseGroup("a"),
        rules: [{ use: "openai/gpt-5", time: { from: "25:00", to: "08:00" } }],
      }),
    ).rejects.toThrow("Invalid window start")
    await expect(
      upsertRoutingGroup({
        ...baseGroup("a"),
        rules: [{ use: "openai/not-a-member" }],
      }),
    ).rejects.toThrow("use is not a member of the group")

    // Nothing was written by the rejected calls.
    expect(await listRoutingGroups()).toEqual([])
  })

  test("validates members, nested groups and the fast list", async () => {
    expect(() =>
      validateGroup({
        ...baseGroup("a"),
        members: ["openai/gpt-5", "openai/gpt-5"],
      }),
    ).toThrow("is a duplicate")

    expect(() =>
      validateGroup({
        ...baseGroup("a", ["group/b:fast"]),
      }),
    ).toThrow("must not use :fast")

    expect(() => validateGroup({ ...baseGroup("a", ["group/a"]) })).toThrow(
      "points at its own group",
    )

    expect(() =>
      validateGroup(
        { ...baseGroup("a", ["group/b"]) },
        { knownGroupIds: ["a"] },
      ),
    ).toThrow("references an unknown group")

    expect(() =>
      validateGroup({
        ...baseGroup("a", ["openai/gpt-5"]),
        fast: ["openai/o3"],
      }),
    ).toThrow("fast[0] is not a member of the group")

    expect(() =>
      validateGroup({
        ...baseGroup("a", ["openai/gpt-5"]),
        pick: "openai/o3",
      }),
    ).toThrow("pick is not a member of the group")

    expect(() =>
      validateGroup({ ...baseGroup("a", ["openai/gpt-5"]), levels: ["turbo"] }),
    ).toThrow("levels[0] is not a known effort level")
  })

  test("normalizes members and accepts a fully specified group", () => {
    const group = validateGroup({
      id: "main",
      name: "  Main  ",
      members: ["openai/gpt-5:High:FAST", "group/fast-lane", "openai/o3"],
      rules: [
        {
          use: "openai/gpt-5:high",
          tokens: 100_000,
          effort: "high",
          agents: ["codex"],
          intent: "code",
          compact: false,
          time: {
            from: "09:00",
            to: "17:00",
            days: ["mon", "tue", "wed", "thu", "fri"],
          },
        },
      ],
      pick: "openai/o3",
      fast: ["openai/gpt-5:high"],
      levels: ["HIGH", "xhigh"],
      classifier: { provider: "openai", model: "classifier-small" },
    })

    expect(group.name).toBe("Main")
    expect(group.members).toEqual([
      "openai/gpt-5:high:fast",
      "group/fast-lane",
      "openai/o3",
    ])
    expect(group.fast).toEqual(["openai/gpt-5"])
    expect(group.levels).toEqual(["high", "xhigh"])
    // A nested member with an effort suffix is a reference, not a variant, so
    // the fast flag is the only suffix checked on it.
    expect(isNestedGroupMember(group.members[1] ?? "")).toBe(true)
  })

  test("group ids must be unique across a list", async () => {
    expect(() =>
      validateRoutingGroups([baseGroup("a"), baseGroup("a")]),
    ).toThrow("duplicate group id")
    await expect(
      replaceRoutingGroups([baseGroup("a"), baseGroup("a")]),
    ).rejects.toThrow(RoutingGroupValidationError)
    expect(await listRoutingGroups()).toEqual([])
  })
})
