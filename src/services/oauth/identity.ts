import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getCredentialContextString,
  listAccountManagedConnections,
  providerFromProtocol,
} from "~/lib/provider-connections"

/** The stable identity of an OAuth account: the vendor's account id, and the
 *  email it was signed in with. */
interface OAuthIdentity {
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
 * as `identity`, for `provider`.
 *
 * Email is the only per-user identity here: for Codex the JWT's
 * `chatgpt_account_id` is a *workspace* id shared by every member of a
 * Team/Enterprise workspace, so two different sign-ins can return the same
 * value. Treating `accountId` alone as "same account" merges those members
 * into one connection — each new login silently overwrites the previous
 * user's tokens (CPA avoids this by keying credential files on
 * accountHash+email, never account_id alone).
 *
 * So: an email match always merges (the user's workspace id may change across
 * logins); an accountId match merges only when emails don't positively
 * disagree. This still dedupes real re-logins — two copies of one rotating
 * refresh token would each refresh on their own and invalidate the other.
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
    if (same(other.email, identity.email)) return true
    const emailConflict =
      Boolean(other.email)
      && Boolean(identity.email)
      && !same(other.email, identity.email)
    return same(other.accountId, identity.accountId) && !emailConflict
  })
}
