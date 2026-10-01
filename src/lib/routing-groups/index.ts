/**
 * Routing groups: named member pools with first-match rules.
 *
 * Backend module only — nothing here is wired into a route or into `state`
 * yet. A caller that wants a group resolves it with {@link firstMatch}, then
 * hands the winning member to the existing route-target selection.
 */

export {
  classifierTargetOf,
  classifyIntent,
  hasIntentClassifier,
  type IntentClassifier,
  type IntentClassifierInput,
  registerIntentClassifier,
  resetIntentClassifierForTest,
} from "./classifier"
export {
  cleanMember,
  FAST_SUFFIX,
  isNestedGroupMember,
  NESTED_GROUP_PREFIX,
  nestedGroupId,
  normalizeMember,
  memberEffort,
  memberFast,
  withMemberEffort,
  type KnownModelCheck,
  type ParsedMemberEffort,
  type ParsedMemberFast,
} from "./member"
export {
  effortSatisfies,
  firstMatch,
  firstMatchingRule,
  hasConditions,
  ruleMatches,
  type RuleContext,
} from "./rules"
export {
  clearRoutingGroupsCacheForTest,
  deleteRoutingGroup,
  getRoutingGroup,
  listRoutingGroups,
  replaceRoutingGroups,
  RoutingGroupValidationError,
  routingGroupsPath,
  upsertRoutingGroup,
  validateGroup,
  validateRoutingGroups,
  type ValidateGroupOptions,
} from "./store"
export {
  DAY_NAMES,
  daysText,
  holds,
  normalizeWindow,
  parseDay,
  parseTime,
  TimeWindowError,
  windowText,
  type DayName,
  type NormalizedWindow,
} from "./time-window"
export {
  EFFORT_ANY,
  EFFORT_LEVELS,
  EFFORT_OFF_VALUES,
  EFFORT_UNRANKED_VALUES,
  effortRank,
  isEffortLevel,
  isEffortOff,
  readEffort,
  type EffortLevel,
  type EffortReading,
  type EffortSpec,
  type RoutingGroup,
  type Rule,
  type TimeWindow,
} from "./types"
