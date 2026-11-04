/** Shared cancellation identity without importing route, provider or state modules. */
export class ClientAbortError extends Error {
  constructor() {
    super("Abort")
    this.name = "ClientAbortError"
  }
}

export function isClientAbortError(
  error: unknown,
  clientSignalAborted: boolean,
): boolean {
  return (
    error instanceof ClientAbortError
    || (clientSignalAborted
      && (error instanceof Error || error instanceof DOMException)
      && error.name === "AbortError")
  )
}
