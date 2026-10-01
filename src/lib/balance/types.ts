/**
 * Balance (money left on an account/key) types.
 *
 * A balance is the money side of a credential, distinct from the quota
 * subsystem's window percentages: it is what remains on a prepaid key or an
 * account wallet. Every vendor answers on its own endpoint and shape, so a
 * `BalanceSource` pairs that endpoint with a reader that turns its JSON body
 * into a normalized `BalanceResult`.
 */

/** Normalized balance: an amount plus how to show it. */
export interface BalanceResult {
  amount: number
  currency: string
  /** Preformatted for display, e.g. "¥12.34" / "$3.00". */
  display: string
  raw?: unknown
}

/** One place a balance can be read from. */
export interface BalanceSource {
  url: string
  /**
   * Optional dedicated balance token. When present it is sent as the whole
   * `Authorization` header instead of the caller's key.
   */
  token?: string
  /** Turn a raw response body into a balance, or undefined when unreadable. */
  read: (body: string) => BalanceResult | undefined
}
