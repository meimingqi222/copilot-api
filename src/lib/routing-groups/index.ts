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
  type IntentClassifierInput,
  registerIntentClassifier,
  resetIntentClassifierForTest,
} from "./classifier"
export {
  cleanMember,
  isNestedGroupMember,
  nestedGroupId,
  normalizeMember,
  memberEffort,
  memberFast,
  withMemberEffort,
} from "./member"
export { firstMatch, ruleMatches, type RuleContext } from "./rules"
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
} from "./time-window"
export { EFFORT_LEVELS, type RoutingGroup } from "./types"
