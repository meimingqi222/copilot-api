/**
 * Auto-derived routing groups.
 *
 * A model more than one connection serves under the same name is a group of
 * those connections, derived on every read and never stored. The user's own
 * groups always win: one that shares a derived id shadows it, and a derived
 * group the user removed is remembered by id alone (see `store.ts`).
 *
 * Members are spelled the way the request path reads them (`provider/model`,
 * see `route-target/model-reference.ts`), one per serving connection, in the
 * order the connections are listed (priority first, as `cacheModels` orders
 * them). Two connections that would collapse to the same member — the same
 * provider twice — count once.
 *
 * Nothing here touches disk or the network: the caller hands in the served
 * models it read from the connection catalog, so the derivation is pure and
 * cheap enough to run per request.
 */

import type { ProviderConnection } from "~/lib/provider-connections"

import { resolveModelsDevContext } from "~/lib/models-dev"
import {
  accountManagedModelPrefix,
  isAccountManagedConnection,
  listProviderConnections,
} from "~/lib/provider-connections"
import { isProviderId } from "~/lib/provider-config"
import { state } from "~/lib/state"

import { NESTED_GROUP_PREFIX } from "./member"
import type { RoutingGroup } from "./types"

/** Id prefix marking a group derived from the catalog rather than authored. */
const AUTO_GROUP_PREFIX = "auto-"

/** One model a connection serves, as the catalog exposes it. */
export interface ServedModel {
  /** Connection that serves it. */
  connectionId: string
  /** Member prefix a request uses to reach that connection. */
  provider: string
  /** The public model id clients send. */
  modelId: string
  /** Display name, when the catalog carries one. */
  name?: string
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}

/**
 * A model's name as vendors agree on it: lower-case, without the vendor's own
 * prefix (`anthropic/claude-sonnet-5` is `claude-sonnet-5`), with a version's
 * dot as Anthropic writes it (`claude-opus-5.5` is `claude-opus-5-5`) and
 * without the snapshot date some add (`claude-opus-5-5-20260801`). A variant
 * after `:` (`:batch`) stays apart, as the suffix is left in place.
 *
 * The key two spellings of one model share.
 */
export function sameModel(id: string): string {
  let key = id.trim().toLowerCase()
  const slash = key.lastIndexOf("/")
  if (slash >= 0) key = key.slice(slash + 1)

  const chars = [...key]
  for (let i = 1; i + 1 < chars.length; i++) {
    if (chars[i] === "." && isDigit(chars[i - 1]) && isDigit(chars[i + 1])) {
      chars[i] = "-"
    }
  }
  key = chars.join("")

  const dash = key.lastIndexOf("-")
  if (dash > 0) {
    const tail = key.slice(dash + 1)
    if (tail.length === 8 && tail.startsWith("20") && /^\d+$/.test(tail)) {
      key = key.slice(0, dash)
    }
  }
  return key
}

/**
 * A name as a group id segment: lower-case, every run of anything but letters
 * and digits collapsed to a single dash.
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** The member reference that reaches a served model through its connection. */
function memberFor(entry: ServedModel): string {
  return entry.modelId.startsWith(`${entry.provider}/`) ?
      entry.modelId
    : `${entry.provider}/${entry.modelId}`
}

/** One model a caller may put in a group, as the editor's picker wants it. */
interface MemberOption {
  /** The string to write in `members` (`provider/model`). */
  member: string
  /** The provider prefix. */
  provider: string
  /** The public model id. */
  modelId: string
  /** Display name, when the catalog carries one. */
  name?: string
  /** Vendor, when the catalog carries one. */
  vendor?: string
  /** Context window in tokens, when known — the picker's "1M" badge. */
  context?: number
  /** The vendor names it free (`:free` or a "free" word). */
  free?: boolean
  /** Reasoning levels the model accepts, when the catalog names them. */
  efforts?: Array<string>
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      value
    : undefined
}

/** The context window a model advertises, from its metadata or the catalog. */
function contextWindowOf(
  publicId: string,
  metadata: Record<string, unknown> | undefined,
  providerHint?: string,
): number | undefined {
  const fromMetadata =
    numberOrUndefined(metadata?.context)
    ?? numberOrUndefined(metadata?.contextWindow)
    ?? numberOrUndefined(metadata?.maxContextWindowTokens)
    ?? numberOrUndefined(metadata?.max_context_window_tokens)
  if (fromMetadata !== undefined) return fromMetadata
  const model = state.models?.data.find((entry) => entry.id === publicId)
  const fromCatalog = numberOrUndefined(
    model?.capabilities?.limits?.max_context_window_tokens,
  )
  if (fromCatalog !== undefined) return fromCatalog
  // Fall back to models.dev, which names the window for most known models.
  const hint =
    typeof providerHint === "string" && isProviderId(providerHint) ?
      providerHint
    : undefined
  return resolveModelsDevContext(publicId, hint)
}

/** Whether a model's id or name names it free, without matching "freedom". */
function isFreeModel(publicId: string, name: string | undefined): boolean {
  const hay = `${publicId} ${name ?? ""}`.toLowerCase()
  return /(^|[^a-z])free([^a-z]|$)/.test(hay)
}

/**
 * Every model a caller may add to a group, deduplicated by member string, in
 * the order the connections are listed. This is what a member picker offers, so
 * the user chooses from the catalog instead of typing `provider/model` by hand.
 */
export function listMemberOptions(
  connections: Array<ProviderConnection> = listProviderConnections(),
): Array<MemberOption> {
  const out: Array<MemberOption> = []
  const seen = new Set<string>()
  for (const connection of connections) {
    if (!connection.enabled) continue
    if (!connection.credentials?.some((credential) => credential.enabled)) {
      continue
    }
    const provider =
      isAccountManagedConnection(connection) ?
        accountManagedModelPrefix(connection)
      : connection.id
    for (const model of connection.models ?? []) {
      if (model.enabled === false) continue
      if (model.hidden) continue
      const member = memberFor({
        connectionId: connection.id,
        provider,
        modelId: model.publicId,
      })
      if (seen.has(member)) continue
      seen.add(member)
      const context = contextWindowOf(model.publicId, model.metadata, provider)
      const catalogModel = state.models?.data.find(
        (entry) => entry.id === model.publicId,
      )
      const efforts = catalogModel?.capabilities?.supports?.reasoning_effort
      out.push({
        member,
        provider,
        modelId: model.publicId,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.vendor === undefined ? {} : { vendor: model.vendor }),
        ...(context === undefined ? {} : { context }),
        ...(isFreeModel(model.publicId, model.name) ? { free: true } : {}),
        ...(efforts && efforts.length > 0 ? { efforts: [...efforts] } : {}),
      })
    }
  }
  return out
}

/**
 * The models every connection currently serves, as `deriveAutoGroups` wants
 * them. Account-managed connections are prefixed with their model prefix (the
 * id a request uses to reach them); plain connections with their own id.
 * Disabled connections, disabled models and hidden mappings are left out, the
 * same way the public catalog leaves them out.
 */
export function collectServedModels(
  connections: Array<ProviderConnection> = listProviderConnections(),
): Array<ServedModel> {
  const out: Array<ServedModel> = []
  for (const connection of connections) {
    if (!connection.enabled) continue
    if (!connection.credentials?.some((credential) => credential.enabled)) {
      continue
    }
    const provider =
      isAccountManagedConnection(connection) ?
        accountManagedModelPrefix(connection)
      : connection.id
    for (const model of connection.models ?? []) {
      if (model.enabled === false) continue
      if (model.hidden) continue
      out.push({
        connectionId: connection.id,
        provider,
        modelId: model.publicId,
        ...(model.name === undefined ? {} : { name: model.name }),
      })
    }
  }
  return out
}

/**
 * A group per model two or more connections serve under the same name, in the
 * order the models were first seen. Each is tagged `auto: true` and carries no
 * rules: it resolves by leading with its first member (see `resolve.ts`), so a
 * `group/auto-<id>` reference routes out of the box. The user's own group of
 * the same id shadows it — the store drops a derived group whose id is already
 * stored.
 */
export function deriveAutoGroups(
  entries: Array<ServedModel>,
): Array<RoutingGroup> {
  const order: Array<string> = []
  const byKey = new Map<string, Array<ServedModel>>()
  for (const entry of entries) {
    const key = sameModel(entry.modelId)
    if (key === "") continue
    let list = byKey.get(key)
    if (!list) {
      list = []
      byKey.set(key, list)
      order.push(key)
    }
    // One member per provider: the same provider twice counts once.
    if (!list.some((other) => other.provider === entry.provider)) {
      list.push(entry)
    }
  }

  const groups: Array<RoutingGroup> = []
  for (const key of order) {
    const serving = byKey.get(key) ?? []
    if (serving.length < 2) continue
    const named = serving.find((entry) => (entry.name ?? "").trim() !== "")
    groups.push({
      id: `${AUTO_GROUP_PREFIX}${slug(key)}`,
      name: (named?.name ?? serving[0]?.modelId ?? key).trim(),
      members: serving.map(memberFor),
      rules: [],
      auto: true,
    })
  }
  return groups
}

/**
 * The group a bare model id names, as `group/<id>`. It looks the id up as
 * itself, as its slugged name and as its auto-group id, so `claude-opus-5.5`
 * finds `auto-claude-opus-5-5`. An id that already carries a provider (`a/m`)
 * names that provider's model, never a group, so it resolves to undefined.
 */
export function groupReferenceFor(
  modelId: string,
  groups: Array<RoutingGroup>,
): string | undefined {
  const trimmed = modelId.trim()
  if (trimmed === "" || trimmed.includes("/")) return undefined
  const key = slug(sameModel(trimmed))
  const candidates = [trimmed.toLowerCase(), key, `${AUTO_GROUP_PREFIX}${key}`]
  for (const candidate of candidates) {
    const found = groups.find((group) => group.id.toLowerCase() === candidate)
    if (found) return `${NESTED_GROUP_PREFIX}${found.id}`
  }
  return undefined
}
