/**
 * Routing-group persistence.
 *
 * All groups live in one JSON file under the app data dir, beside the other
 * user-editable state. It is read lazily on first use and cached in memory;
 * every mutation validates, writes the whole file atomically (tmp + rename,
 * with a `.bak` copy) and only then updates the cache — a failed write leaves
 * the previous list in place.
 *
 * Validation is strict on purpose: a group is hand-editable config, and a rule
 * naming a member that does not exist, a `:fast` flag on a nested group or an
 * effort outside the known levels would otherwise be dead config that silently
 * routes nothing.
 */

import path from "node:path"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Mutex, Repository } from "~/lib/repository"

import { collectServedModels, deriveAutoGroups } from "./auto"
import {
  cleanMember,
  isNestedGroupMember,
  nestedGroupId,
  normalizeMember,
} from "./member"
import {
  EFFORT_ANY,
  isEffortLevel,
  isGroupAffinityMode,
  isGroupEffortSource,
  isRoutingMode,
} from "./types"
import type {
  GroupAffinityMode,
  GroupEffortSource,
  GroupRoutingMode,
  RoutingGroup,
  Rule,
} from "./types"

import { TimeWindowError, normalizeWindow } from "./time-window"

/** File the groups are stored in, under {@link PATHS}.APP_DIR. */
const FILE_NAME = "routing-groups.json"

const CURRENT_FILE_VERSION = 1

interface PersistedRoutingGroupsFile {
  version: number
  groups: Array<RoutingGroup>
  /**
   * Ids of derived groups the user removed, so they stay gone without being
   * materialized. A derived group is back the moment its id leaves this list,
   * which is what {@link restoreAutoGroup} does.
   */
  hiddenAutoGroups?: Array<string>
}

/** Absolute path of the groups file. Resolved per call: the data dir moves in tests. */
export function routingGroupsPath(): string {
  return path.join(PATHS.APP_DIR, FILE_NAME)
}

const repo = new Repository<PersistedRoutingGroupsFile>({
  filePath: () => routingGroupsPath(),
  serialize: (data) => JSON.stringify(data, null, 2),
  deserialize: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${FILE_NAME} has unexpected shape`)
    }
    const file = parsed as Partial<PersistedRoutingGroupsFile>
    if (!Array.isArray(file.groups)) {
      throw new Error(`${FILE_NAME} has unexpected shape`)
    }
    return {
      version: file.version ?? CURRENT_FILE_VERSION,
      groups: file.groups,
      hiddenAutoGroups:
        Array.isArray(file.hiddenAutoGroups) ?
          file.hiddenAutoGroups.filter(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          )
        : [],
    }
  },
  corruptMessage: `${FILE_NAME} is corrupt.`,
})

export class RoutingGroupValidationError extends Error {
  readonly problems: Array<string>

  constructor(problems: Array<string>) {
    super(`Invalid routing group: ${problems.join("; ")}`)
    this.name = "RoutingGroupValidationError"
    this.problems = problems
  }
}

interface ValidateGroupOptions {
  /** Ids of the other groups, so nested references can be checked. */
  knownGroupIds?: Iterable<string>
  /** Whether an id is a real model, so its own suffixes are left alone. */
  isKnownModel?: (id: string) => boolean
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function validateRule(
  rule: Rule,
  index: number,
  memberKeys: ReadonlySet<string>,
  problems: Array<string>,
): void {
  if (typeof rule !== "object" || rule === null) {
    problems.push(`rules[${index}] must be an object`)
    return
  }

  const label = `rules[${index}]`
  const use = typeof rule.use === "string" ? rule.use.trim() : ""
  if (use === "") {
    problems.push(`${label}.use is required`)
  } else if (memberKeys.size > 0 && !memberKeys.has(cleanMember(use))) {
    problems.push(`${label}.use is not a member of the group: ${use}`)
  }

  if (rule.tokens !== undefined && !Number.isFinite(rule.tokens)) {
    problems.push(`${label}.tokens must be a number`)
  }
  if (rule.images !== undefined && typeof rule.images !== "boolean") {
    problems.push(`${label}.images must be a boolean`)
  }
  if (rule.compact !== undefined && typeof rule.compact !== "boolean") {
    problems.push(`${label}.compact must be a boolean`)
  }
  if (
    rule.effort !== undefined
    && !isEffortLevel(rule.effort)
    && rule.effort !== EFFORT_ANY
  ) {
    problems.push(`${label}.effort is not a known effort level: ${rule.effort}`)
  }
  if (
    rule.agents !== undefined
    && (!Array.isArray(rule.agents)
      || rule.agents.some((a) => !isNonEmptyString(a)))
  ) {
    problems.push(`${label}.agents must be a list of names`)
  }
  if (rule.intent !== undefined && !isNonEmptyString(rule.intent)) {
    problems.push(`${label}.intent must be a non-empty string`)
  }
  if (rule.time !== undefined) {
    try {
      normalizeWindow(rule.time)
    } catch (error) {
      const message =
        error instanceof TimeWindowError ? error.message : "invalid time window"
      problems.push(`${label}.time: ${message}`)
    }
  }
}

interface GroupRoutingFields {
  expose?: boolean
  routing?: GroupRoutingMode
  affinity?: GroupAffinityMode
  effort?: GroupEffortSource
}

/** Read and check a group's routing / affinity / effort, collecting problems. */
function validateGroupRouting(
  group: RoutingGroup,
  problems: Array<string>,
): GroupRoutingFields {
  const out: GroupRoutingFields = {}
  if (group.expose !== undefined) {
    if (typeof group.expose === "boolean") out.expose = group.expose
    else problems.push("expose must be a boolean")
  }
  if (group.routing !== undefined) {
    if (isRoutingMode(group.routing)) {
      out.routing = group.routing.trim().toLowerCase() as GroupRoutingMode
    } else {
      problems.push(`routing is not a known mode: ${String(group.routing)}`)
    }
  }
  if (group.affinity !== undefined) {
    if (isGroupAffinityMode(group.affinity)) {
      out.affinity = group.affinity.trim().toLowerCase() as GroupAffinityMode
    } else {
      problems.push(`affinity is not a known mode: ${String(group.affinity)}`)
    }
  }
  if (group.effort !== undefined) {
    if (isGroupEffortSource(group.effort)) {
      out.effort = group.effort.trim().toLowerCase() as GroupEffortSource
    } else {
      problems.push(`effort is not a known source: ${String(group.effort)}`)
    }
  }
  return out
}

/**
 * Check a group and return a normalized copy: members canonicalized, rules
 * trimmed. Throws {@link RoutingGroupValidationError} listing every problem,
 * rather than stopping at the first one.
 */
export function validateGroup(
  group: RoutingGroup,
  options: ValidateGroupOptions = {},
): RoutingGroup {
  const problems: Array<string> = []

  if (typeof group !== "object" || group === null) {
    throw new RoutingGroupValidationError(["group must be an object"])
  }

  const id = typeof group.id === "string" ? group.id.trim() : ""
  if (id === "") {
    problems.push("id is required")
  } else if (/[\s/]/.test(id)) {
    problems.push(`id must not contain whitespace or "/": ${id}`)
  }

  const name = typeof group.name === "string" ? group.name.trim() : ""
  if (name === "") problems.push("name is required")

  const rawMembers = Array.isArray(group.members) ? group.members : undefined
  if (!rawMembers) problems.push("members must be an array")

  const members: Array<string> = []
  const memberKeys = new Set<string>()
  for (const [index, raw] of (rawMembers ?? []).entries()) {
    if (!isNonEmptyString(raw)) {
      problems.push(`members[${index}] must be a non-empty string`)
      continue
    }
    const member = normalizeMember(raw, options.isKnownModel)
    if (isNestedGroupMember(member, options.isKnownModel)) {
      const nested = nestedGroupId(member, options.isKnownModel)
      if (nested === undefined) {
        problems.push(`members[${index}] has an empty group reference: ${raw}`)
        continue
      }
      if (nested === id) {
        problems.push(`members[${index}] points at its own group: ${raw}`)
        continue
      }
      // The fast flag marks a connection's variant; it means nothing to a
      // group, so a nested member carrying one is a mistake, not a variant.
      if (member.toLowerCase().endsWith(":fast")) {
        problems.push(
          `members[${index}] is a nested group and must not use :fast: ${raw}`,
        )
        continue
      }
      if (
        options.knownGroupIds !== undefined
        && ![...options.knownGroupIds].includes(nested)
      ) {
        problems.push(`members[${index}] references an unknown group: ${raw}`)
        continue
      }
    }
    if (members.includes(member)) {
      problems.push(`members[${index}] is a duplicate: ${raw}`)
      continue
    }
    members.push(member)
    memberKeys.add(cleanMember(member, options.isKnownModel))
  }

  const rules: Array<Rule> = []
  const rawRules = Array.isArray(group.rules) ? group.rules : undefined
  if (!rawRules) problems.push("rules must be an array")
  for (const [index, rule] of (rawRules ?? []).entries()) {
    validateRule(rule, index, memberKeys, problems)
    if (typeof rule === "object" && rule !== null) rules.push(rule)
  }

  const pick = group.pick === undefined ? undefined : String(group.pick).trim()
  if (pick !== undefined) {
    if (pick === "") {
      problems.push("pick must not be empty")
    } else if (!memberKeys.has(cleanMember(pick, options.isKnownModel))) {
      problems.push(`pick is not a member of the group: ${pick}`)
    }
  }

  let fast: Array<string> | undefined
  if (group.fast !== undefined) {
    if (!Array.isArray(group.fast)) {
      problems.push("fast must be an array")
    } else {
      fast = []
      for (const [index, raw] of group.fast.entries()) {
        if (!isNonEmptyString(raw)) {
          problems.push(`fast[${index}] must be a non-empty string`)
          continue
        }
        if (!memberKeys.has(cleanMember(raw, options.isKnownModel))) {
          problems.push(`fast[${index}] is not a member of the group: ${raw}`)
          continue
        }
        fast.push(cleanMember(raw, options.isKnownModel))
      }
    }
  }

  let levels: Array<string> | undefined
  if (group.levels !== undefined) {
    if (!Array.isArray(group.levels)) {
      problems.push("levels must be an array")
    } else {
      levels = []
      for (const [index, raw] of group.levels.entries()) {
        const level = typeof raw === "string" ? raw.trim().toLowerCase() : ""
        if (!isEffortLevel(level)) {
          problems.push(
            `levels[${index}] is not a known effort level: ${String(raw)}`,
          )
          continue
        }
        if (!levels.includes(level)) levels.push(level)
      }
    }
  }

  let classifier: { provider: string; model: string } | undefined
  if (group.classifier !== undefined) {
    const provider = String(group.classifier?.provider ?? "").trim()
    const model = String(group.classifier?.model ?? "").trim()
    if (provider === "" || model === "") {
      problems.push("classifier needs a provider and a model")
    } else {
      classifier = { provider, model }
    }
  }

  const routingFields = validateGroupRouting(group, problems)
  const { effort } = routingFields

  // `effort: auto` needs a classifier to rate how hard each turn is.
  if (effort === "auto" && classifier === undefined) {
    problems.push("effort auto needs the group's classifier")
  }

  if (problems.length > 0) throw new RoutingGroupValidationError(problems)

  return {
    id,
    name,
    members,
    rules: rules.map((rule) => ({ ...rule, use: rule.use.trim() })),
    ...(pick === undefined ? {} : { pick }),
    ...(fast === undefined ? {} : { fast }),
    ...(levels === undefined ? {} : { levels }),
    ...(classifier === undefined ? {} : { classifier }),
    ...routingFields,
  }
}

/** Validate a whole list: every group valid, every id unique. */
export function validateRoutingGroups(
  groups: Array<RoutingGroup>,
  options: ValidateGroupOptions = {},
): Array<RoutingGroup> {
  if (!Array.isArray(groups)) {
    throw new RoutingGroupValidationError(["groups must be an array"])
  }

  const knownGroupIds = groups
    .map((group) => (isNonEmptyString(group?.id) ? group.id.trim() : ""))
    .filter((id) => id !== "")

  const validated: Array<RoutingGroup> = []
  const seen = new Set<string>()
  const problems: Array<string> = []

  for (const group of groups) {
    let next: RoutingGroup
    try {
      next = validateGroup(group, { ...options, knownGroupIds })
    } catch (error) {
      if (error instanceof RoutingGroupValidationError) {
        problems.push(
          ...error.problems.map(
            (problem) =>
              `${isNonEmptyString(group?.id) ? group.id : "group"}: ${problem}`,
          ),
        )
        continue
      }
      throw error
    }
    if (seen.has(next.id)) {
      problems.push(`duplicate group id: ${next.id}`)
      continue
    }
    seen.add(next.id)
    validated.push(next)
  }

  if (problems.length > 0) throw new RoutingGroupValidationError(problems)
  return validated
}

// ── Cache ─────────────────────────────────────────────────────────

let cache: Array<RoutingGroup> = []
/** Ids of derived groups the user removed; read and written with the groups. */
let hiddenAutoGroups: Array<string> = []
/** Path the cache was read from; a different one (tests relocate it) reloads. */
let cachePath: string | undefined

const mutex = new Mutex()

interface LoadedGroups {
  groups: Array<RoutingGroup>
  hidden: Array<string>
}

async function readFromDisk(): Promise<LoadedGroups> {
  const file = await repo.load()
  if (!file) return { groups: [], hidden: [] }

  const knownGroupIds = file.groups
    .map((group) => (isNonEmptyString(group?.id) ? group.id.trim() : ""))
    .filter((id) => id !== "")

  const groups: Array<RoutingGroup> = []
  const seen = new Set<string>()
  for (const group of file.groups) {
    try {
      const validated = validateGroup(group, { knownGroupIds })
      if (seen.has(validated.id)) {
        logger.warn(
          `[routing-groups] dropping duplicate group id: ${validated.id}`,
        )
        continue
      }
      seen.add(validated.id)
      groups.push(validated)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[routing-groups] dropping invalid group: ${message}`)
    }
  }
  return { groups, hidden: file.hiddenAutoGroups ?? [] }
}

async function ensureLoaded(): Promise<Array<RoutingGroup>> {
  const currentPath = routingGroupsPath()
  if (cachePath === currentPath) return cache
  const loaded = await readFromDisk()
  cache = loaded.groups
  hiddenAutoGroups = loaded.hidden
  cachePath = currentPath
  return cache
}

/**
 * Write the whole file, then swap the cache. The cache is only replaced after
 * the write succeeded, so a failed save cannot leave memory ahead of disk.
 */
async function persist(
  groups: Array<RoutingGroup>,
  hidden: Array<string> = hiddenAutoGroups,
): Promise<void> {
  await repo.save({
    version: CURRENT_FILE_VERSION,
    groups,
    hiddenAutoGroups: hidden,
  })
  cache = groups
  hiddenAutoGroups = hidden
  cachePath = routingGroupsPath()
}

/** Derived groups for the current catalog, minus the ones the user removed. */
function currentDerivedGroups(): Array<RoutingGroup> {
  const hidden = new Set(hiddenAutoGroups)
  return deriveAutoGroups(collectServedModels()).filter(
    (group) => !hidden.has(group.id),
  )
}

// ── Public API ────────────────────────────────────────────────────

/** Stored custom groups only; synthetic legacy references stay out of lists. */
export async function listRoutingGroups(): Promise<Array<RoutingGroup>> {
  const stored = await ensureLoaded()
  return structuredClone(stored)
}

export async function getRoutingGroup(
  id: string,
): Promise<RoutingGroup | undefined> {
  const groups = await ensureLoaded()
  const found = groups.find((group) => group.id === id)
  if (found) return structuredClone(found)
  const derived = currentDerivedGroups().find((group) => group.id === id)
  // Resolve old client references without advertising synthetic groups.
  return derived ? structuredClone({ ...derived, routing: "smart" }) : undefined
}

/** Insert or replace one group, keeping its position in the list. */
export async function upsertRoutingGroup(
  group: RoutingGroup,
): Promise<RoutingGroup> {
  return mutex.runExclusive(async () => {
    const groups = await ensureLoaded()
    // Derived ids count too, so a stored group may nest `group/auto-…`.
    const knownGroupIds = [
      ...groups.map((existing) => existing.id),
      ...currentDerivedGroups().map((derived) => derived.id),
    ].filter((id) => id !== group.id)
    const validated = validateGroup(group, { knownGroupIds })

    const next = groups.slice()
    const index = next.findIndex((existing) => existing.id === validated.id)
    if (index >= 0) next[index] = validated
    else next.push(validated)

    await persist(next)
    return structuredClone(validated)
  })
}

/**
 * Remove one group. A stored group is deleted; a derived one the user removes
 * is only hidden (recorded by id), so it stays gone without being written out.
 * True when there was a stored or derived group to remove.
 */
export async function deleteRoutingGroup(id: string): Promise<boolean> {
  return mutex.runExclusive(async () => {
    const groups = await ensureLoaded()
    const next = groups.filter((group) => group.id !== id)
    if (next.length !== groups.length) {
      await persist(next)
      return true
    }
    if (hiddenAutoGroups.includes(id)) return false
    if (!currentDerivedGroups().some((group) => group.id === id)) return false
    await persist(groups, [...hiddenAutoGroups, id])
    return true
  })
}

/**
 * Bring back a derived group the user removed, by dropping its hidden record.
 * True when there was one to restore.
 */
export async function restoreAutoGroup(id: string): Promise<boolean> {
  return mutex.runExclusive(async () => {
    if (!hiddenAutoGroups.includes(id)) return false
    await persist(
      await ensureLoaded(),
      hiddenAutoGroups.filter((hidden) => hidden !== id),
    )
    return true
  })
}

/** The ids of derived groups the user removed, so an editor can list them. */
export async function listHiddenAutoGroups(): Promise<Array<string>> {
  await ensureLoaded()
  return [...hiddenAutoGroups]
}

/** Replace the whole list, validating every group (and id uniqueness) first. */
export async function replaceRoutingGroups(
  groups: Array<RoutingGroup>,
): Promise<Array<RoutingGroup>> {
  return mutex.runExclusive(async () => {
    const validated = validateRoutingGroups(groups)
    await persist(validated)
    return structuredClone(validated)
  })
}

/** Forget the in-memory cache, so the next call reads the file again. */
export function clearRoutingGroupsCacheForTest(): void {
  cache = []
  hiddenAutoGroups = []
  cachePath = undefined
}
