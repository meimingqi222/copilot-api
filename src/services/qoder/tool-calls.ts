import { HTTPError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

interface QoderToolCall {
  name: string
  args: string
}

export type QoderFragment =
  | { kind: "text"; text: string }
  | { kind: "call"; call: QoderToolCall }

type Tools = NonNullable<ChatCompletionsPayload["tools"]>
const OPEN = "<tool_call>"
const CLOSE = "</tool_call>"
const MARKS = [
  OPEN,
  "<function=",
  "<invoke ",
  "<antml:invoke ",
  "<function_calls>",
  "<antml:function_calls>",
  "</function_calls>",
  "</antml:function_calls>",
]

function invalid(truncated: boolean): never {
  const message =
    truncated ? "Qoder: tool call cut short" : "Qoder: unreadable tool call"
  throw new HTTPError(message, new Response(message, { status: 502 }), message)
}

function parseCall(value: string, tools: Tools): QoderToolCall | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) {
    let framed: Record<string, unknown> | undefined
    try {
      framed = asRecord(JSON.parse(trimmed))
    } catch {
      return undefined
    }
    if (typeof framed?.name !== "string" || !framed.name.trim())
      return undefined
    let args = framed.arguments
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        return undefined
      }
    }
    if (!asRecord(args)) return undefined
    return { name: framed.name.trim(), args: JSON.stringify(args) }
  }
  const match =
    /^<(?:function=([^<>]+)|(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)")\s*>([\s\S]*?)<\/(?:function|(?:antml:)?invoke)\s*>$/.exec(
      trimmed,
    )
  if (!match) return undefined
  const name = (match[1] ?? match[2] ?? "").trim()
  if (!name) return undefined
  const props = asRecord(
    tools.find((t) => t.function.name === name)?.function.parameters
      ?.properties,
  )
  const args: Record<string, unknown> = {}
  const body = match[3] ?? ""
  const re =
    /<(?:antml:)?parameter(?:=([^\s<>]+)|\s+name\s*=\s*"([^"<>]+)")\s*>([\s\S]*?)<\/(?:antml:)?parameter\s*>/g
  let consumed = 0
  for (const param of body.matchAll(re)) {
    if (body.slice(consumed, param.index).trim()) return undefined
    consumed = param.index + param[0].length
    const key = param[1] ?? param[2] ?? ""
    const raw = param[3] ?? ""
    if (asRecord(props?.[key])?.type === "string") args[key] = raw
    else {
      try {
        args[key] = JSON.parse(raw)
      } catch {
        args[key] = raw
      }
    }
  }
  if (body.slice(consumed).trim()) return undefined
  return { name, args: JSON.stringify(args) }
}

/** Incremental XML splitter. Wrapped calls remain compatible without tool declarations. */
export class QoderToolCallSplitter {
  private textBuf = ""
  private parts: Array<string> = []
  private tail = ""
  private close = ""
  private opener = ""
  private fence = false
  private inline = false
  private ticks = 0
  private wrappers = 0
  private readonly tools: Tools
  sawTool = false

  constructor(tools?: Tools | null) {
    this.tools = tools ?? []
  }

  private text(out: Array<QoderFragment>, text: string) {
    if (!text) return
    for (const char of text) {
      if (char === "`") {
        this.ticks++
        continue
      }
      if (this.ticks >= 3) this.fence = !this.fence
      else if (this.ticks && !this.fence) this.inline = !this.inline
      this.ticks = 0
      if (char === "\n" && !this.fence) this.inline = false
    }
    out.push({ kind: "text", text })
  }

  feed(input: string): Array<QoderFragment> {
    const out: Array<QoderFragment> = []
    let rest = input
    while (rest) {
      if (this.close) {
        const scan = this.tail + rest
        const at = scan.indexOf(this.close)
        if (at < 0) {
          this.parts.push(rest)
          this.tail = scan.slice(-(this.close.length - 1))
          break
        }
        const count = at - this.tail.length
        const full = this.parts.join("") + rest
        const body = full.slice(0, full.length - rest.length + count)
        const call = parseCall(
          this.opener + body + (this.opener ? this.close : ""),
          this.tools,
        )
        if (!call) {
          if (
            this.opener
            || body.trimStart().startsWith("{")
            || body.includes("<function=")
          )
            invalid(false)
          this.text(out, OPEN + body + CLOSE)
        } else {
          out.push({ kind: "call", call })
          this.sawTool = true
        }
        rest = rest.slice(count + this.close.length)
        this.parts = []
        this.tail = ""
        this.close = ""
        this.opener = ""
        continue
      }
      const combined = this.textBuf + rest
      this.textBuf = ""
      const at = combined.indexOf("<")
      if (at < 0) {
        this.text(out, combined)
        break
      }
      this.text(out, combined.slice(0, at))
      const candidate = combined.slice(at)
      const quoted =
        (this.ticks >= 3 ? !this.fence : this.fence)
        || (this.ticks > 0 && this.ticks < 3 ? !this.inline : this.inline)
      const marks = this.tools.length ? MARKS : [OPEN]
      if (!quoted && marks.some((m) => m.startsWith(candidate))) {
        if (candidate !== OPEN && !candidate.endsWith(">")) {
          this.textBuf = candidate
          break
        }
      }
      if (!quoted && candidate.startsWith(OPEN)) {
        this.close = CLOSE
        rest = candidate.slice(OPEN.length)
        continue
      }
      if (!quoted && this.tools.length) {
        const wrapper = /^<(?:antml:)?function_calls>/.exec(candidate)
        if (wrapper) {
          const next = candidate.slice(wrapper[0].length).trimStart()
          const end = next.indexOf(">")
          if (
            end < 0
            && (!next
              || MARKS.some((m) => m.startsWith(next))
              || /^<(?:function=|(?:antml:)?invoke\s)/.test(next))
          ) {
            this.textBuf = candidate
            break
          }
          const name =
            /^<(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)"\s*>/.exec(next)?.[1]
            ?? /^<function=([^\s<>]+)\s*>/.exec(next)?.[1]
          if (name && this.tools.some((t) => t.function.name === name)) {
            this.wrappers++
            rest = candidate.slice(wrapper[0].length)
            continue
          }
        }
        const wrapperClose = /^<\/(?:antml:)?function_calls>/.exec(candidate)
        if (wrapperClose && this.wrappers > 0) {
          this.wrappers--
          rest = candidate.slice(wrapperClose[0].length)
          continue
        }
        if (/^<(?:function=|(?:antml:)?invoke\s)/.test(candidate)) {
          const end = candidate.indexOf(">")
          if (end < 0) {
            this.textBuf = candidate
            break
          }
          const opener = candidate.slice(0, end + 1)
          const name =
            /^<function=([^\s<>]+)\s*>$/.exec(opener)?.[1]
            ?? /^<(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)"\s*>$/.exec(
              opener,
            )?.[1]
          if (name && this.tools.some((t) => t.function.name === name)) {
            this.opener = opener
            this.close =
              opener.startsWith("<function=") ? "</function>"
              : opener.startsWith("<antml:") ? "</antml:invoke>"
              : "</invoke>"
            rest = candidate.slice(end + 1)
            continue
          }
        }
      }
      this.text(out, "<")
      rest = candidate.slice(1)
    }
    return out
  }

  flush(): Array<QoderFragment> {
    if (this.close) {
      const body = this.parts.join("")
      const call = parseCall(this.opener + body, this.tools)
      if (!call) {
        if (
          this.opener
          || body.trimStart().startsWith("{")
          || body.includes("<function=")
        )
          invalid(true)
        this.close = ""
        this.parts = []
        this.tail = ""
        return [{ kind: "text", text: OPEN + body }]
      }
      this.close = ""
      this.parts = []
      this.tail = ""
      this.opener = ""
      this.sawTool = true
      return [{ kind: "call", call }]
    }
    const out: Array<QoderFragment> = []
    this.text(out, this.textBuf)
    this.textBuf = ""
    return out
  }
}
