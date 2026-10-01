import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getCredentialContextString,
  listAccountManagedConnections,
  providerFromProtocol,
} from "~/lib/provider-connections"

/** The stable identity of an OAuth account: the vendor's account id, and the
 *  email it was signed in with. */
export interface OAuthIdentity {
  accountId?: string
  email?: string
}

/** An OAuth account's identity as a connection carries it. */
export function connectionOAuthIdentity(
  connection: ProviderConnection,
): OAuthIdentity {
  return {
    accountId: getCredentialContextString(connection, "oauthAccountId"),
    email: getCredentialContextString(connection, "email"),
  }
}

function same(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Find an existing account-managed connection that is the *same* OAuth account
 * as `identity`, for `provider`: the same vendor account id, or failing that
 * the same email.
 *
 * This is what keeps one account from becoming two connections — two copies of
 * one refresh token, each refreshing on its own, which (with a rotating
 * refresh token) invalidates the other. Sign-in and import both dedupe on it.
 */
export function findConnectionByOAuthIdentity(
  provider: string | undefined,
  identity: OAuthIdentity,
  connections: Array<ProviderConnection> = listAccountManagedConnections(),
): ProviderConnection | undefined {
  if (!identity.accountId && !identity.email) return undefined
  return connections.find((conn) => {
    if (provider && providerFromProtocol(conn.protocol) !== provider) {
      return false
    }
    const other = connectionOAuthIdentity(conn)
    return (
      same(other.accountId, identity.accountId)
      || same(other.email, identity.email)
    )
  })
}
