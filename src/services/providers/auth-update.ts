import { isDeepStrictEqual } from "node:util"

import type { ProviderConnection } from "~/lib/provider-connections"
import { setConnectionAuthStatus } from "~/lib/provider-connections"
import type { OAuthFetchOptions } from "~/services/oauth/fetch"
import type { OAuthRefreshFn } from "~/services/oauth/strategy-types"

interface AuthRecordUpdate {
  set: Record<string, unknown>
  remove: Array<string>
}

/** Only authentication fields cross this boundary; no connection snapshot replacement. */
export interface ProviderAuthUpdate {
  credentialId: string
  value?: string
  context: AuthRecordUpdate
  credentialExtras: AuthRecordUpdate
  settings: AuthRecordUpdate
  routing: AuthRecordUpdate
  authStatus?: string
  authError?: string | null
}

export type OAuthRefreshOperation = (
  connection: ProviderConnection,
  refreshToken: string,
  options: OAuthFetchOptions,
) => Promise<void>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function recordUpdate(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): AuthRecordUpdate {
  const set: Record<string, unknown> = {}
  const remove: Array<string> = []
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (
      Object.hasOwn(previous, key) === Object.hasOwn(next, key)
      && isDeepStrictEqual(previous[key], next[key])
    )
      continue
    if (Object.hasOwn(next, key)) set[key] = structuredClone(next[key])
    else remove.push(key)
  }
  return { set, remove }
}

/** Adapt existing bundle decoders without giving them the live account state. */
export function prepareOAuthRefresh(
  operation: OAuthRefreshOperation,
): OAuthRefreshFn {
  return async (
    connection: ProviderConnection,
    refreshToken: string,
    options: OAuthFetchOptions,
  ): Promise<ProviderAuthUpdate> => {
    const previous = structuredClone(connection)
    const draft = structuredClone(previous)
    await operation(draft, refreshToken, options)
    const credential = previous.credentials[0]
    const updated = draft.credentials[0]
    if (!credential || !updated || credential.id !== updated.id) {
      throw new Error("Provider refresh must preserve credential identity")
    }
    const oldMeta = previous.metadata ?? {}
    const newMeta = draft.metadata ?? {}
    return {
      credentialId: credential.id,
      ...(credential.value !== updated.value ? { value: updated.value } : {}),
      context: recordUpdate(credential.context ?? {}, updated.context ?? {}),
      credentialExtras: recordUpdate(
        asRecord(oldMeta.credentialExtras),
        asRecord(newMeta.credentialExtras),
      ),
      settings: recordUpdate(
        asRecord(oldMeta.settings),
        asRecord(newMeta.settings),
      ),
      routing: recordUpdate(
        {
          tokenEndpoint: oldMeta.tokenEndpoint,
          redirectUri: oldMeta.redirectUri,
        },
        {
          tokenEndpoint: newMeta.tokenEndpoint,
          redirectUri: newMeta.redirectUri,
        },
      ),
      ...((
        (oldMeta.authStatus !== newMeta.authStatus
          || oldMeta.authError !== newMeta.authError
          || credential.status !== updated.status
          || credential.value !== updated.value)
        && typeof newMeta.authStatus === "string"
      ) ?
        {
          authStatus: newMeta.authStatus,
          authError:
            typeof newMeta.authError === "string" ? newMeta.authError : null,
        }
      : {}),
    }
  }
}

function applyRecordUpdate(
  target: Record<string, unknown>,
  update: AuthRecordUpdate,
): void {
  for (const key of update.remove) delete target[key]
  for (const [key, value] of Object.entries(update.set)) {
    Object.defineProperty(target, key, {
      value: structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
}

/** Host application merges only changed fields, preserving concurrent quota/model/admin work. */
export function applyProviderAuthUpdate(
  connection: ProviderConnection,
  update: ProviderAuthUpdate,
): void {
  const credential = connection.credentials.find(
    (entry) => entry.id === update.credentialId,
  )
  if (!credential || connection.credentials[0] !== credential) {
    throw new Error("Provider refresh credential is no longer active")
  }
  if (update.value !== undefined) credential.value = update.value
  if (
    Object.keys(update.context.set).length > 0
    || update.context.remove.length > 0
  ) {
    credential.context ??= {}
    applyRecordUpdate(credential.context, update.context)
  }
  const metadata = (connection.metadata ??= {})
  for (const [key, patch] of [
    ["credentialExtras", update.credentialExtras],
    ["settings", update.settings],
  ] as const) {
    if (Object.keys(patch.set).length === 0 && patch.remove.length === 0)
      continue
    const target = asRecord(metadata[key])
    metadata[key] = target
    applyRecordUpdate(target, patch)
  }
  applyRecordUpdate(metadata, update.routing)
  if (update.authStatus !== undefined)
    setConnectionAuthStatus(connection, update.authStatus, update.authError)
}
