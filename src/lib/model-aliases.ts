import type {
  ModelEndpoint,
  ProviderConnection,
} from "~/lib/provider-connections"

import { buildAccountModelAliases, listAccounts } from "~/lib/accounts"
import { listProviderConnections } from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { emitStateChangeSync } from "~/lib/state-events"
import { statsStore } from "~/lib/stats-store"

export type ModelAliasKind = "exact" | "prefix" | "pattern"

export interface ModelAliasScope {
  connectionIds?: Array<string>
  providers?: Array<string>
}

export interface ModelAliasRule {
  id: string
  enabled: boolean
  kind: ModelAliasKind
  from: string
  to: string
  scope?: ModelAliasScope
  exposeInModels: boolean
  note?: string
}

export interface ModelAliasRestriction {
  connectionIds?: Array<string>
  providers?: Array<string>
}

export interface ModelAliasResolution {
  modelId: string
  resolvedModelId: string
  aliasChain: Array<string>
  matchedRuleIds: Array<string>
  restriction?: ModelAliasRestriction
}

const MODEL_ALIASES_CONFIG_KEY = "model_aliases"
const MAX_ALIAS_HOPS = 3

let rules: Array<ModelAliasRule> = []
let activeRulesCache: Array<ModelAliasRule> | null = null

function cloneRules(value: Array<ModelAliasRule>): Array<ModelAliasRule> {
  return structuredClone(value)
}

function invalidateRuleCache(): void {
  activeRulesCache = null
}

function normalizeScope(value: unknown): ModelAliasScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const connectionIds = Array.isArray(record.connectionIds) ?
    record.connectionIds.filter((item): item is string => typeof item === "string")
  : undefined
  const providers = Array.isArray(record.providers) ?
    record.providers.filter((item): item is string => typeof item === "string")
  : undefined
  if ((!connectionIds || connectionIds.length === 0)
    && (!providers || providers.length === 0)) {
    return undefined
  }
  return {
    ...(connectionIds && connectionIds.length > 0 ? { connectionIds } : {}),
    ...(providers && providers.length > 0 ? { providers } : {}),
  }
}

export function validateModelAliasRule(
  input: Partial<ModelAliasRule>,
): ModelAliasRule {
  if (!input.kind || !["exact", "prefix", "pattern"].includes(input.kind)) {
    throw new Error("Invalid alias kind")
  }
  const from = typeof input.from === "string" ? input.from.trim() : ""
  const to = typeof input.to === "string" ? input.to.trim() : ""
  if (!from || !to) throw new Error("Alias from and to are required")

  const fromStars = (from.match(/\*/g) ?? []).length
  const toStars = (to.match(/\*/g) ?? []).length
  if (input.kind === "pattern" && fromStars !== 1) {
    throw new Error("Pattern aliases must contain exactly one '*' in from")
  }
  if (input.kind !== "pattern" && fromStars > 0) {
    throw new Error("Only pattern aliases may contain '*' in from")
  }
  if (input.kind !== "pattern" && toStars > 0) {
    throw new Error("Only pattern aliases may contain '*' in to")
  }
  if (input.kind === "pattern" && toStars > 1) {
    throw new Error("Pattern aliases may contain at most one '*' in to")
  }

  return {
    id: typeof input.id === "string" && input.id.trim() ?
      input.id.trim()
    : crypto.randomUUID(),
    enabled: input.enabled !== false,
    kind: input.kind,
    from,
    to,
    scope: normalizeScope(input.scope),
    exposeInModels: input.exposeInModels === true,
    ...(typeof input.note === "string" && input.note.trim() ?
      { note: input.note.trim() }
    : {}),
  }
}

export function loadModelAliases(): void {
  const raw = statsStore.getConfig(MODEL_ALIASES_CONFIG_KEY)
  if (!raw) {
    rules = []
    state.modelAliases = []
    invalidateRuleCache()
    return
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    rules = Array.isArray(parsed) ?
      parsed.map((item) => validateModelAliasRule(item as Partial<ModelAliasRule>))
    : []
    state.modelAliases = cloneRules(rules)
    invalidateRuleCache()
  } catch {
    rules = []
    state.modelAliases = []
    invalidateRuleCache()
  }
}

export function listModelAliases(): Array<ModelAliasRule> {
  return cloneRules(rules)
}

export function replaceModelAliases(
  nextRules: Array<Partial<ModelAliasRule>>,
): Array<ModelAliasRule> {
  rules = nextRules.map((rule) => validateModelAliasRule(rule))
  state.modelAliases = cloneRules(rules)
  invalidateRuleCache()
  statsStore.setConfig(MODEL_ALIASES_CONFIG_KEY, JSON.stringify(rules))
  emitStateChangeSync("models-stale")
  return listModelAliases()
}

export function upsertModelAlias(
  input: Partial<ModelAliasRule>,
): ModelAliasRule {
  const normalized = validateModelAliasRule(input)
  const index = rules.findIndex((rule) => rule.id === normalized.id)
  if (index === -1) {
    rules.push(normalized)
  } else {
    rules[index] = normalized
  }
  state.modelAliases = cloneRules(rules)
  invalidateRuleCache()
  statsStore.setConfig(MODEL_ALIASES_CONFIG_KEY, JSON.stringify(rules))
  emitStateChangeSync("models-stale")
  return structuredClone(normalized)
}

export function deleteModelAlias(id: string): boolean {
  const next = rules.filter((rule) => rule.id !== id)
  if (next.length === rules.length) return false
  rules = next
  state.modelAliases = cloneRules(rules)
  invalidateRuleCache()
  statsStore.setConfig(MODEL_ALIASES_CONFIG_KEY, JSON.stringify(rules))
  emitStateChangeSync("models-stale")
  return true
}

export function __resetModelAliasesForTest(): void {
  rules = []
  invalidateRuleCache()
}

function connectionProvider(connection: ProviderConnection): string | undefined {
  const provider = connection.metadata?.provider
  if (typeof provider === "string") return provider
  if (connection.protocol.endsWith("-native")) {
    const providerId = connection.protocol.slice(0, -"-native".length)
    return providerId === "mimo" ? "mimo-aistudio" : providerId
  }
  return undefined
}

export function connectionMatchesAliasRestriction(
  connection: ProviderConnection,
  restriction?: ModelAliasRestriction,
): boolean {
  if (!restriction) return true
  if (
    restriction.connectionIds
    && !restriction.connectionIds.includes(connection.id)
  ) {
    return false
  }
  if (restriction.providers) {
    const provider = connectionProvider(connection)
    if (
      !provider
      || !restriction.providers.some(
        (item) => item.toLowerCase() === provider.toLowerCase(),
      )
    ) {
      return false
    }
  }
  return true
}

function intersectRestrictions(
  left: ModelAliasRestriction | undefined,
  right: ModelAliasScope | undefined,
): ModelAliasRestriction | undefined {
  if (!left && !right) return undefined

  const connectionIds =
    left?.connectionIds && right?.connectionIds ?
      left.connectionIds.filter((id) => right.connectionIds?.includes(id))
    : left?.connectionIds ?? right?.connectionIds

  const providers =
    left?.providers && right?.providers ?
      left.providers.filter((provider) =>
        right.providers?.some(
          (item) => item.toLowerCase() === provider.toLowerCase(),
        ),
      )
    : left?.providers ?? right?.providers

  return {
    ...(connectionIds ? { connectionIds } : {}),
    ...(providers ? { providers } : {}),
  }
}

function applyRule(rule: ModelAliasRule, modelId: string): string | undefined {
  const normalized = modelId.toLowerCase()
  const from = rule.from.toLowerCase()

  if (rule.kind === "exact") {
    return normalized === from ? rule.to : undefined
  }

  if (rule.kind === "prefix") {
    return normalized.startsWith(from) ?
      `${rule.to}${modelId.slice(rule.from.length)}`
    : undefined
  }

  const star = rule.from.indexOf("*")
  const before = rule.from.slice(0, star)
  const after = rule.from.slice(star + 1)
  if (
    !normalized.startsWith(before.toLowerCase())
    || !normalized.endsWith(after.toLowerCase())
    || modelId.length < before.length + after.length
  ) {
    return undefined
  }
  const capture = modelId.slice(
    before.length,
    modelId.length - after.length || undefined,
  )
  return rule.to.replace("*", capture)
}

function reverseRule(rule: ModelAliasRule, modelId: string): string | undefined {
  const normalized = modelId.toLowerCase()
  const to = rule.to.toLowerCase()

  if (rule.kind === "exact") {
    return normalized === to ? rule.from : undefined
  }

  if (rule.kind === "prefix") {
    return normalized.startsWith(to) ?
      `${rule.from}${modelId.slice(rule.to.length)}`
    : undefined
  }

  const star = rule.to.indexOf("*")
  if (star < 0) {
    return normalized === to ? rule.from : undefined
  }
  const before = rule.to.slice(0, star)
  const after = rule.to.slice(star + 1)
  if (
    !normalized.startsWith(before.toLowerCase())
    || !normalized.endsWith(after.toLowerCase())
    || modelId.length < before.length + after.length
  ) {
    return undefined
  }
  const capture = modelId.slice(
    before.length,
    modelId.length - after.length || undefined,
  )
  return rule.from.replace("*", capture)
}

function getSortedActiveRules(): Array<ModelAliasRule> {
  if (activeRulesCache) return activeRulesCache
  const kindOrder: Record<ModelAliasKind, number> = {
    exact: 0,
    prefix: 1,
    pattern: 2,
  }
  activeRulesCache = rules
    .filter((rule) => rule.enabled)
    .toSorted((left, right) =>
      kindOrder[left.kind] - kindOrder[right.kind]
      || right.from.length - left.from.length
      || left.id.localeCompare(right.id),
    )
  return activeRulesCache
}

function modelIsReal(modelId: string, connectionId?: string): boolean {
  const connections = connectionId ?
    listProviderConnections().filter((connection) => connection.id === connectionId)
  : listProviderConnections()

  for (const connection of connections) {
    for (const model of connection.models ?? []) {
      if (!model.enabled) continue
      const ids = [model.publicId, ...(model.aliases ?? [])]
      if (ids.some((id) => id.toLowerCase() === modelId.toLowerCase())) {
        return true
      }
    }
  }

  const accounts = connectionId ?
    listAccounts().filter((account) => account.id === connectionId)
  : listAccounts()
  return accounts.some((account) =>
    (account.availableModels ?? []).some((model) =>
      buildAccountModelAliases(account, model.id).some(
        (id) => id.toLowerCase() === modelId.toLowerCase(),
      ),
    ),
  )
}

export function resolveModelAlias(
  requestedModelId: string,
  connectionId?: string,
): ModelAliasResolution {
  const sortedRules = getSortedActiveRules()
  if (sortedRules.length === 0) {
    return {
      modelId: requestedModelId,
      resolvedModelId: requestedModelId,
      aliasChain: [requestedModelId],
      matchedRuleIds: [],
    }
  }

  let current = requestedModelId
  const aliasChain = [current]
  const matchedRuleIds: Array<string> = []
  let restriction: ModelAliasRestriction | undefined
  const visited = new Set([current.toLowerCase()])

  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    if (modelIsReal(current, connectionId)) break

    let matchedRule: ModelAliasRule | undefined
    let replacement: string | undefined
    for (const rule of sortedRules) {
      replacement = applyRule(rule, current)
      if (replacement !== undefined) {
        matchedRule = rule
        break
      }
    }
    if (!matchedRule || replacement === undefined) break

    matchedRuleIds.push(matchedRule.id)
    restriction = intersectRestrictions(restriction, matchedRule.scope)

    const key = replacement.toLowerCase()
    if (visited.has(key)) break
    visited.add(key)
    current = replacement
    aliasChain.push(current)
  }

  return {
    modelId: requestedModelId,
    resolvedModelId: current,
    aliasChain,
    matchedRuleIds,
    ...(restriction ? { restriction } : {}),
  }
}

export function getExposedAliasEntries(
  publicIds: Array<{
    publicId: string
    connectionId: string
    endpoints: Array<ModelEndpoint>
    pickerEnabled: boolean
    pickerCategory?: string
    name?: string
    vendor?: string
  }>,
  connections: Array<ProviderConnection> = listProviderConnections(),
): typeof publicIds {
  const additions: typeof publicIds = []
  const sortedRules = getSortedActiveRules()
  if (sortedRules.length === 0) return additions
  for (const entry of publicIds) {
    for (const rule of sortedRules) {
      if (!rule.enabled || !rule.exposeInModels) continue
      const alias = reverseRule(rule, entry.publicId)
      if (!alias || alias === entry.publicId) continue

      const connection = connections.find(
        (candidate) => candidate.id === entry.connectionId,
      )
      if (
        connection
        && !connectionMatchesAliasRestriction(connection, rule.scope)
      ) {
        continue
      }

      additions.push({ ...entry, publicId: alias })
    }
  }
  return additions
}
