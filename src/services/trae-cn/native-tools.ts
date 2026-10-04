interface PendingCall {
  upstreamId: string
  name: string
  arguments?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function mergeArguments(previous: unknown, next: unknown): unknown {
  if (next === undefined) return previous
  if (typeof next !== "string" || typeof previous !== "string") return next
  // Cumulative snapshots (including a replay) replace the previous buffer.
  if (!previous || next.startsWith(previous)) return next
  return previous + next
}

/** Native tool deltas retain one identity until all argument fragments arrive. */
export class TraeCnNativeTools {
  private calls: Array<PendingCall> = []
  private byId = new Map<string, PendingCall>()
  private byIndex = new Map<number, PendingCall>()
  private anonymous = new Map<string, PendingCall>()

  push(value: unknown): void {
    const call = record(value)
    const fn = record(call.function ?? call.function_call ?? call)
    const id = String(call.id ?? call.tool_call_id ?? "")
    const index = typeof call.index === "number" ? call.index : undefined
    const name = String(fn.name ?? call.tool_name ?? "")
    const args = fn.arguments ?? call.params ?? call.input ?? call.parameters
    const key =
      !id && index === undefined ? `${name}:${JSON.stringify(args)}` : undefined
    let pending =
      (id ? this.byId.get(id) : undefined)
      ?? (index !== undefined ? this.byIndex.get(index) : undefined)
      ?? (key ? this.anonymous.get(key) : undefined)
    if (!pending) {
      pending = { upstreamId: id, name }
      this.calls.push(pending)
      if (key) this.anonymous.set(key, pending)
    }
    if (id) {
      pending.upstreamId ||= id
      this.byId.set(id, pending)
    }
    if (index !== undefined) this.byIndex.set(index, pending)
    pending.name ||= name
    pending.arguments = mergeArguments(pending.arguments, args)
  }

  finish(): Array<PendingCall> {
    return this.calls.filter((call) => call.name)
  }
}
