import { asRecordOrEmpty } from "~/lib/json-shape"
import {
  looseJSON,
  traeNameCall,
  traeNameHasWrapper,
} from "~/services/trae-cn/tool-normalize"

interface PendingCall {
  upstreamId: string
  name: string
  arguments?: unknown
}

function mergeArguments(previous: unknown, next: unknown): unknown {
  if (next === undefined) return previous
  if (typeof next !== "string" || typeof previous !== "string") return next
  // Cumulative snapshots (including a replay) replace the previous buffer.
  if (!previous || next.startsWith(previous)) return next
  return previous + next
}

/** name 里写着的整段调用（客户端 wrapper / GLM 交接）读出来，合并参数。 */
function resolveNameHandoff(
  call: PendingCall,
  tools: ReadonlyArray<unknown>,
): PendingCall {
  const name = call.name
  const trimmed = name.trimStart()
  let w: { name?: unknown; arguments?: unknown } | null = null
  if (trimmed.startsWith("{")) {
    w = looseJSON(name) ?? traeNameCall(name, tools)
  } else if (traeNameHasWrapper(name)) {
    w = traeNameCall(name, tools)
  }
  if (!w || typeof w.name !== "string" || !w.name) return call
  if (call.arguments === null) return { ...call, name: w.name }
  const fromName =
    w.arguments && typeof w.arguments === "object" ?
      JSON.stringify(w.arguments)
    : "{}"
  const own =
    typeof call.arguments === "string" ? call.arguments.trim()
    : call.arguments && typeof call.arguments === "object" ?
      JSON.stringify(call.arguments)
    : ""
  let args = fromName
  if (own && own !== "{}") {
    const ownObj = looseJSON(own)
    const sideObj = looseJSON(fromName)
    args = ownObj && sideObj ? JSON.stringify({ ...sideObj, ...ownObj }) : own
  }
  return { ...call, name: w.name, arguments: args }
}

/** Native tool deltas retain one identity until all argument fragments arrive. */
export class TraeCnNativeTools {
  private calls: Array<PendingCall> = []
  private byId = new Map<string, PendingCall>()
  private byIndex = new Map<number, PendingCall>()
  private anonymous = new Map<string, PendingCall>()
  private tools: ReadonlyArray<unknown>

  constructor(tools: ReadonlyArray<unknown> = []) {
    this.tools = tools
  }

  push(value: unknown): void {
    const call = asRecordOrEmpty(value)
    const fn = asRecordOrEmpty(call.function ?? call.function_call ?? call)
    const id = String(call.id ?? call.tool_call_id ?? "")
    const index = typeof call.index === "number" ? call.index : undefined
    const name = String(fn.name ?? call.tool_name ?? "")
    const args = [fn.arguments, call.params, call.input, call.parameters].find(
      (input) => input !== undefined,
    )
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
    // name 也像 arguments 一样是逐渐长长的快照：更长的同前缀 name 取代旧的
    //（wrapper 在标签处截断、随后整段再来）。
    if (!pending.name) pending.name = name
    else if (name && name.startsWith(pending.name) && name !== pending.name) {
      pending.name = name
    }
    pending.arguments = mergeArguments(pending.arguments, args)
  }

  finish(): Array<PendingCall> {
    return this.calls
      .filter((call) => call.name)
      .map((call) => resolveNameHandoff(call, this.tools))
  }
}
