/**
 * What a system log line is about, carried through async work so the 459
 * existing `logger.*` calls need no new arguments: a line written while a
 * request is being served carries its requestId, one written by a background
 * job carries the job and its run.
 */

import { AsyncLocalStorage } from "node:async_hooks"

interface LogContext {
  /** Request id, as in `X-Request-Id` and the request log. */
  req?: string
  /** Connection the request was routed to, once dispatch chose one. */
  conn?: string
  /** Background job name (see `~/lib/jobs`). */
  job?: string
  /** One run of that job. */
  run?: string
}

const storage = new AsyncLocalStorage<LogContext>()

export function runWithLogContext<T>(context: LogContext, run: () => T): T {
  // A job started while serving a request is still that request's.
  return storage.run({ ...storage.getStore(), ...context }, run)
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore()
}

/** Dispatch picked a connection: later lines of this request carry it. */
export function setLogConnection(connectionId: string | undefined): void {
  const context = storage.getStore()
  if (context && connectionId) context.conn = connectionId
}
