/**
 * Member reference parsing.
 *
 * A member is `provider/model` with up to two suffixes appended in a fixed
 * order: a reasoning effort and the fast flag, e.g. `vendor/model:high:fast`.
 *
 * A trailing `:<word>` is only stripped when it is a known effort (or `fast`)
 * *and* the id as a whole is not itself a real model: model ids legitimately
 * end the same way (`.../model:free`, `.../model:7b`, `.../model:0`), and
 * stripping those would invent a member that does not exist. Callers that hold
 * a model catalog pass `isKnownModel` to settle the ambiguous cases; without it
 * the structural rule applies — what is left after a suffix must still look
 * like `provider/model`.
 */

import {
  EFFORT_OFF_VALUES,
  EFFORT_ANY,
  isEffortLevel,
  type EffortLevel,
} from "./types"

/** Members that point at another routing group instead of a connection. */
export const NESTED_GROUP_PREFIX = "group/"

/** Suffix marking the fast variant of a member. */
export const FAST_SUFFIX = "fast"

/** Whether an id is a real model, so its own suffixes must be left alone. */
export type KnownModelCheck = (id: string) => boolean

export interface ParsedMemberEffort {
  /** The member without its effort suffix. */
  model: string
  effort: EffortLevel
}

export interface ParsedMemberFast {
  /** The member without its fast suffix. */
  model: string
  fast: true
}

/** `provider/model` shaped, i.e. something a suffix may be taken off. */
function isMemberShape(model: string): boolean {
  const slashIndex = model.indexOf("/")
  return slashIndex > 0 && slashIndex < model.length - 1
}

function knownModel(id: string, isKnownModel?: KnownModelCheck): boolean {
  return isKnownModel?.(id) ?? false
}

/** Last suffix of `id`, or undefined when there is no colon to split on. */
function splitSuffix(
  id: string,
): { model: string; suffix: string } | undefined {
  const trimmed = id.trim()
  const colon = trimmed.lastIndexOf(":")
  if (colon <= 0) return undefined
  return {
    model: trimmed.slice(0, colon),
    suffix: trimmed
      .slice(colon + 1)
      .trim()
      .toLowerCase(),
  }
}

/** What is left of a member once its suffixes are read. */
interface MemberSuffixes {
  /** The bare `provider/model`. */
  bare: string
  effort?: EffortLevel
  fast: boolean
}

/**
 * Read the whole suffix chain off an id.
 *
 * Both suffixes may be present (`model:effort:fast` is the order callers are
 * told to write), and each is taken at most once, so a model whose own id ends
 * in a known effort keeps it: what is not a suffix we recognize is left where
 * it is.
 */
function stripSuffixes(
  id: string,
  isKnownModel?: KnownModelCheck,
): MemberSuffixes {
  const trimmed = id.trim()
  if (knownModel(trimmed, isKnownModel)) return { bare: trimmed, fast: false }

  let bare = trimmed
  let effort: EffortLevel | undefined
  let fast = false

  for (let pass = 0; pass < 2; pass++) {
    const split = splitSuffix(bare)
    if (!split || !isMemberShape(split.model)) break
    if (split.suffix === FAST_SUFFIX && !fast) {
      fast = true
      bare = split.model
      continue
    }
    if (isEffortLevel(split.suffix) && effort === undefined) {
      effort = split.suffix
      bare = split.model
      continue
    }
    break
  }

  const stripped = bare.trim()
  return {
    bare: stripped,
    ...(effort === undefined ? {} : { effort }),
    fast,
  }
}

/**
 * Split a trailing `:<level>` off a member.
 *
 * Returns undefined when there is no suffix to split: an unknown word, a bare
 * model id, or an id that is a real model on its own.
 */
export function memberEffort(
  id: string,
  isKnownModel?: KnownModelCheck,
): ParsedMemberEffort | undefined {
  const trimmed = id.trim()
  if (knownModel(trimmed, isKnownModel)) return undefined
  const split = splitSuffix(trimmed)
  if (!split || !isEffortLevel(split.suffix) || !isMemberShape(split.model)) {
    return undefined
  }
  return { model: split.model, effort: split.suffix as EffortLevel }
}

/** Split a trailing `:fast` off a member, by the same rules as {@link memberEffort}. */
export function memberFast(
  id: string,
  isKnownModel?: KnownModelCheck,
): ParsedMemberFast | undefined {
  const trimmed = id.trim()
  if (knownModel(trimmed, isKnownModel)) return undefined
  const split = splitSuffix(trimmed)
  if (!split || split.suffix !== FAST_SUFFIX || !isMemberShape(split.model)) {
    return undefined
  }
  return { model: split.model, fast: true }
}

/** The member with both suffixes removed. Whitespace is trimmed, case is kept. */
export function cleanMember(
  id: string,
  isKnownModel?: KnownModelCheck,
): string {
  const trimmed = id.trim()
  const stripped = stripSuffixes(trimmed, isKnownModel).bare
  return stripped === "" ? trimmed : stripped
}

/**
 * Canonical spelling of a member, suffixes included: `:effort` lower-cased and
 * `:fast` last. This is what a store writes back, so two spellings of the same
 * member compare equal.
 */
export function normalizeMember(
  id: string,
  isKnownModel?: KnownModelCheck,
): string {
  const trimmed = id.trim()
  const stripped = stripSuffixes(trimmed, isKnownModel)
  if (stripped.bare === "") return trimmed
  return [
    stripped.bare,
    stripped.effort === undefined ? "" : `:${stripped.effort}`,
    stripped.fast ? `:${FAST_SUFFIX}` : "",
  ].join("")
}

/**
 * Set (or clear) a member's effort while keeping its `:fast` flag last.
 * An empty string, `off`, `none` or `disabled` removes the effort.
 */
export function withMemberEffort(model: string, effort: string): string {
  const normalized = effort.trim().toLowerCase()
  const stripped = stripSuffixes(model)
  const tail = stripped.fast ? `:${FAST_SUFFIX}` : ""

  if (
    normalized === ""
    || (EFFORT_OFF_VALUES as readonly string[]).includes(normalized)
  ) {
    return `${stripped.bare}${tail}`
  }
  if (isEffortLevel(normalized) || normalized === EFFORT_ANY) {
    return `${stripped.bare}:${normalized}${tail}`
  }
  throw new Error(`Unknown reasoning effort: ${effort}`)
}

/** Whether a member points at another routing group. */
export function isNestedGroupMember(
  id: string,
  isKnownModel?: KnownModelCheck,
): boolean {
  return cleanMember(id, isKnownModel).startsWith(NESTED_GROUP_PREFIX)
}

/** The group id a `group/<id>` member points at, if any. */
export function nestedGroupId(
  id: string,
  isKnownModel?: KnownModelCheck,
): string | undefined {
  const bare = cleanMember(id, isKnownModel)
  if (!bare.startsWith(NESTED_GROUP_PREFIX)) return undefined
  const groupId = bare.slice(NESTED_GROUP_PREFIX.length).trim()
  return groupId === "" ? undefined : groupId
}
