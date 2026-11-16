import { randomUUID } from "node:crypto"

import { parseXmlToolCall } from "~/services/tool-call-text"
import type { TraeChatCall } from "~/services/trae-cn/client"
import { traeToolNamed } from "~/services/trae-cn/tool-normalize"

interface TextCall {
  name: string
  arguments: Record<string, unknown>
}

interface TextResult {
  text: string
  calls: Array<TraeChatCall>
  parts?: Array<
    { text: string } | { reasoning: string } | { call: TraeChatCall }
  >
  error?: string
}

const MARKS = [
  "<tool_call",
  "<toolcall",
  "<｜DSML｜",
  "</｜DSML｜",
  "<|DSML|",
  "</|DSML|",
  '{"reasoning_content"',
  "<function_calls>",
  "</function_calls>",
  "<antml:function_calls>",
  "</antml:function_calls>",
  "<invoke ",
  "<antml:invoke ",
  "</invoke>",
  "</antml:invoke>",
  "<fun" + "ction=",
  "</function>",
]
// 工具调用块 opener：tool_call / DSML，以及裸的 Anthropic/Qwen XML
//（function_calls 包裹、invoke name=、function=，含 antml: 前缀）。
const OPEN =
  /<tool_?call(?=[\s>{])|<\/?[｜|]DSML[｜|]|<\/?(?:antml:)?function_calls\s*>|<(?:antml:)?invoke(?=[\s>])|<function=/
const REASON = /\{\s*"reasoning_content"\s*:/
const UNREADABLE = "Trae returned an unreadable or truncated tool call"

/** The first complete JSON object; braces inside quoted strings are data. */
function objectEnd(value: string): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) return i + 1
  }
  return -1
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function endsString(after: string, isKey: boolean, inArray: boolean): boolean {
  if (isKey) return /^\s*:/.test(after)
  if (inArray) return /^\s*(?:[}\]]\s*)*(?:$|,\s*["{[\d\-tfn])/.test(after)
  return /^\s*(?:[}\]]\s*)*(?:$|,\s*")/.test(after)
}

/** Repair string boundaries and raw controls, never reinterpret path escapes. */
function repairQuotes(source: string): string {
  let out = ""
  const stack: Array<string> = []
  let key = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch !== '"') {
      if (ch === "{") {
        stack.push(ch)
        key = true
      } else if (ch === "[") stack.push(ch)
      else if (ch === "}" || ch === "]") stack.pop()
      else if (ch === ",") key = stack.at(-1) === "{"
      else if (ch === ":") key = false
      out += ch
      continue
    }
    const isKey = key && stack.at(-1) === "{"
    const inArray = stack.at(-1) === "["
    out += ch
    for (i++; i < source.length; i++) {
      const c = source[i]!
      if (c === "\\") {
        out += c + (source[++i] ?? "")
        continue
      }
      if (c === "\n" || c === "\r" || c === "\t") {
        out += JSON.stringify(c).slice(1, -1)
        continue
      }
      if (c !== '"') {
        out += c
        continue
      }
      const after = source.slice(i + 1)
      if (endsString(after, isKey, inArray)) {
        out += c
        break
      }
      out += '\\"'
    }
    key = false
  }
  return out
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = attempt === 0 ? raw : repairQuotes(raw)
    try {
      const value = object(JSON.parse(candidate))
      if (value) return value
    } catch {
      /* Try the bounded string repair; failure is surfaced by the caller. */
    }
  }
  return undefined
}

function jsonCall(raw: string): TextCall | undefined {
  const value = jsonObject(raw)
  if (!value || typeof value.name !== "string" || !value.name) return undefined
  let args: unknown = [
    value.arguments,
    value.input,
    value.parameters,
    value.params,
  ].find((input) => input !== undefined)
  if (args === undefined) args = {}
  for (let i = 0; i < 3 && typeof args === "string"; i++)
    args = jsonObject(args)
  const parameters = object(args)
  return parameters ? { name: value.name, arguments: parameters } : undefined
}

function parameter(raw: string, string = false): unknown {
  if (!string) {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      /* Plain text stays byte-for-byte intact. */
    }
  }
  return raw
}

function glmCall(
  raw: string,
  isStringParameter: (name: string, key: string) => boolean,
): TextCall | undefined {
  const head = /^\s*([\w.:-]+)\s*(?=<arg_key>)/.exec(raw)
  if (!head) return undefined
  const args: Record<string, unknown> = {}
  const body = raw.slice(head[0].length)
  const pair =
    /<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  let consumed = 0
  for (const match of body.matchAll(pair)) {
    if (body.slice(consumed, match.index).trim()) return undefined
    const key = match[1]!.trim()
    args[key] = parameter(match[2]!, isStringParameter(head[1]!, key))
    consumed = match.index + match[0].length
  }
  if (!consumed || body.slice(consumed).trim()) return undefined
  return { name: head[1]!, arguments: args }
}

function dsmlCall(raw: string, name: string): TextCall | undefined {
  const args: Record<string, unknown> = {}
  const pair =
    /<[｜|]DSML[｜|]parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/[｜|]DSML[｜|]parameter>/g
  let consumed = 0
  for (const match of raw.matchAll(pair)) {
    if (raw.slice(consumed, match.index).trim()) return undefined
    args[match[1]!] = parameter(match[3]!, /\bstring="true"/.test(match[2]!))
    consumed = match.index + match[0].length
  }
  if (raw.slice(consumed).trim()) return undefined
  return { name, arguments: args }
}

function wrappedDsmlCall(raw: string): TextCall | undefined {
  const match =
    /^\s*<[｜|]DSML[｜|]invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]DSML[｜|]invoke>\s*$/.exec(
      raw,
    )
  return match ? dsmlCall(match[2]!, match[1]!) : undefined
}

// Anthropic/Qwen 的 XML 调用参数（两种形态，含 antml: 前缀）。不完整参数体或
// 参数间/尾部杂字一律拒（undefined）；字符串参数原样保留，不重解路径反斜杠。
const XML_PARAM =
  /<(?:antml:)?parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g

function xmlParams(
  raw: string,
  name: string,
  isStringParameter: (name: string, key: string) => boolean,
): TextCall | undefined {
  const args: Record<string, unknown> = {}
  let consumed = 0
  let found = false
  for (const match of raw.matchAll(XML_PARAM)) {
    if (raw.slice(consumed, match.index).trim()) return undefined
    const key = (match[1] ?? match[2] ?? "").trim()
    if (!key) return undefined
    args[key] = parameter(match[3]!, isStringParameter(name, key))
    consumed = match.index + match[0].length
    found = true
  }
  if (!found || raw.slice(consumed).trim()) return undefined
  return { name, arguments: args }
}

function inCode(text: string): boolean {
  let delimiter = 0
  for (const match of text.matchAll(/`+/g)) {
    if (!delimiter) delimiter = match[0].length
    else if (delimiter === match[0].length) delimiter = 0
  }
  return delimiter !== 0
}

/** Hold only possible call prefixes; code examples remain ordinary text. */
export class TraeCnTextTools {
  private buf = ""
  private sent = ""
  private failed = false
  private stringParameters = new Map<string, Set<string>>()
  private declared = new Set<string>()
  private tools: ReadonlyArray<unknown>

  constructor(tools: ReadonlyArray<unknown> = []) {
    this.tools = tools
    for (const tool of tools) {
      const entry = object(tool)
      const fn = object(entry?.function) ?? entry
      if (typeof fn?.name !== "string") continue
      this.declared.add(fn.name)
      const properties = object(object(fn.parameters)?.properties) ?? {}
      this.stringParameters.set(
        fn.name,
        new Set(
          Object.keys(properties).filter(
            (key) => object(properties[key])?.type === "string",
          ),
        ),
      )
    }
  }

  private isStringParameter = (name: string, key: string): boolean =>
    this.stringParameters.get(name)?.has(key) ?? false

  private failure(text: string): TextResult {
    this.failed = true
    this.buf = ""
    return { text, calls: [], error: UNREADABLE }
  }

  private readCall(
    raw: string,
    dsmlName?: string,
    xmlName?: string,
  ): TextCall | undefined {
    if (dsmlName) return dsmlCall(raw, dsmlName)
    if (xmlName !== undefined) {
      return this.declared.has(xmlName) ?
          xmlParams(raw, xmlName, this.isStringParameter)
        : undefined
    }
    return (
      jsonCall(raw.trim())
      ?? wrappedDsmlCall(raw)
      ?? parseXmlToolCall(raw, this.isStringParameter)
      ?? glmCall(raw, this.isStringParameter)
    )
  }

  push(piece: string, end = false): TextResult {
    if (this.failed) return { text: "", calls: [], error: UNREADABLE }
    this.buf += piece
    let text = ""
    const calls: Array<TraeChatCall> = []
    const parts: NonNullable<TextResult["parts"]> = []
    let emitted = 0
    const flushText = () => {
      if (text.length > emitted) parts.push({ text: text.slice(emitted) })
      emitted = text.length
    }
    for (;;) {
      const opening = OPEN.exec(this.buf)
      const reason = REASON.exec(this.buf)
      if (reason && (!opening || reason.index < opening.index)) {
        const head = this.buf.slice(0, reason.index)
        if (inCode(this.sent + text + head)) {
          text += head + "{"
          this.buf = this.buf.slice(reason.index + 1)
          continue
        }
        const at = this.buf.slice(reason.index)
        const endAt = objectEnd(at)
        if (endAt < 0 && !end) {
          text += head
          this.buf = at
          break
        }
        const value = endAt > 0 ? jsonObject(at.slice(0, endAt)) : undefined
        if (typeof value?.reasoning_content === "string") {
          text += head
          flushText()
          parts.push({ reasoning: value.reasoning_content })
          this.buf = at.slice(endAt)
        } else {
          text += head + "{"
          this.buf = at.slice(1)
        }
        continue
      }
      if (!opening) break
      const at = opening.index
      const head = this.buf.slice(0, at)
      if (inCode(this.sent + text + head)) {
        text += head + opening[0]
        this.buf = this.buf.slice(at + opening[0].length)
        continue
      }
      text += head
      this.buf = this.buf.slice(at)
      const tagEnd = this.buf.indexOf(">")
      if (tagEnd < 0) break
      const tag = this.buf.slice(0, tagEnd + 1)
      if (/^<(?:antml:)?function_calls\s*>$/.test(tag)) {
        const closeGroup = /<\/(?:antml:)?function_calls\s*>/g
        closeGroup.lastIndex = tagEnd + 1
        const closing = closeGroup.exec(this.buf)
        if (!closing) break
        const inner = new TraeCnTextTools(this.tools).push(
          this.buf.slice(tagEnd + 1, closing.index),
          true,
        )
        if (inner.error) return this.failure(text)
        const groupEnd = closing.index + closing[0].length
        if (inner.calls.length) {
          flushText()
          parts.push(...(inner.parts ?? []))
          calls.push(...inner.calls)
          text += inner.text
          emitted = text.length
        } else {
          text += this.buf.slice(0, groupEnd)
        }
        this.buf = this.buf.slice(groupEnd)
        continue
      }
      if (/^<\/?[｜|]DSML[｜|]function_calls\s*>$/.test(tag)) {
        this.buf = this.buf.slice(tagEnd + 1)
        continue
      }
      const invoke = /^<[｜|]DSML[｜|]invoke\s+name="([^"]+)"\s*>$/.exec(tag)
      const antInvoke =
        /^<(?:antml:)?invoke\s+name\s*=\s*"([^"<>]+)"\s*>$/.exec(tag)
      const qwenName =
        tag.startsWith("<fun" + "ction=") && tag.endsWith(">") ?
          tag.slice(10, -1).trim()
        : ""
      const isQwen = qwenName.length > 0
      const close =
        invoke ? /<\/[｜|]DSML[｜|]invoke>/g
        : antInvoke ? /<\/(?:antml:)?invoke\s*>/g
        : isQwen ? /<\/function\s*>/g
        : /<\/tool_?call>/g
      close.lastIndex = tagEnd + 1
      const xmlName = traeToolNamed(
        antInvoke?.[1]?.trim() ?? qwenName,
        this.tools,
      )
      const isXml = Boolean(antInvoke) || isQwen
      // 裸 XML 只认请求声明的工具；未声明的当普通文本（agent 可告知无此工具）。
      const xmlDeclared = isXml && this.declared.has(xmlName)
      const looksLikeCall = (s: string) =>
        /^\s*(?:\{|[\w.:-]+\s*<arg_key>)/.test(s)
        || s.includes("<fun" + "ction=")
      let closing = close.exec(this.buf)
      let call: TextCall | undefined
      let raw = ""
      while (closing) {
        raw = this.buf.slice(tagEnd + 1, closing.index)
        call = this.readCall(raw, invoke?.[1], isXml ? xmlName : undefined)
        if (call || (!invoke && !isXml && !looksLikeCall(raw))) break
        // A string argument may itself contain a closing tag.
        const next = close.exec(this.buf)
        if (!next) break
        closing = next
      }
      if (!closing) break
      const intended = Boolean(
        invoke || xmlDeclared || (!isXml && looksLikeCall(raw)),
      )
      if (!call && intended && !end) break
      if (call) {
        const parsed = {
          upstreamId: "",
          id: `call_${randomUUID().replaceAll("-", "")}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        }
        calls.push(parsed)
        flushText()
        parts.push({ call: parsed })
      } else if (intended) {
        return this.failure(text)
      } else {
        text += this.buf.slice(0, closing.index + closing[0].length)
      }
      this.buf = this.buf.slice(closing.index + closing[0].length)
    }
    if (end) {
      const tail = this.buf.slice(this.buf.lastIndexOf("<"))
      if (
        (OPEN.test(this.buf)
          || (tail.length >= 5 && MARKS.some((mark) => mark.startsWith(tail))))
        && !inCode(this.sent + text)
      )
        return this.failure(text)
      text += this.buf
      this.buf = ""
    } else {
      let keep =
        OPEN.test(this.buf) || REASON.test(this.buf) ? this.buf.length : 0
      if (!keep) {
        for (const mark of MARKS) {
          for (let n = Math.min(mark.length, this.buf.length); n > keep; n--) {
            if (mark.startsWith(this.buf.slice(-n))) {
              keep = n
              break
            }
          }
        }
      }
      text += this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
    }
    this.sent += text
    flushText()
    return { text, calls, parts }
  }
}
