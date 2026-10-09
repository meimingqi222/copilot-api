/**
 * Qoder 的工具调用拆解。
 *
 * Qoder 有两种下发工具调用的方式：
 * 1. 原生 OpenAI 形态：`delta.tool_calls[]`，id 由它签发、必须原样保留；
 * 2. 把调用写进 `delta.content` 文本里的 XML：
 *      <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
 *
 * 这个拆分器只负责第 2 种：它是**有状态**的，因为标记可能被切在两个分片中间；
 * 未成形的尾巴要么留着等下一片，要么在流结束时按原文吐出（绝不吞掉用户可见文本）。
 */

import {
  TOOL_CALL_CLOSE as CALL_CLOSE,
  TOOL_CALL_OPEN as CALL_OPEN,
  parseXmlToolCall,
} from "~/services/tool-call-text"

interface QoderToolCall {
  name: string
  args: string
}

export type QoderFragment =
  | { kind: "text"; text: string }
  | { kind: "call"; call: QoderToolCall }

/** 尾部仍可能长成调用标记的长度。 */
function markerSuffix(value: string): number {
  for (let size = CALL_OPEN.length - 1; size > 0; size--) {
    if (value.endsWith(CALL_OPEN.slice(0, size))) return size
  }
  return 0
}

/**
 * 读一个调用块：JSON `{name,arguments}`，或 XML 的 function/parameter 形态。
 * 参数值原样取用（上游没有约定转义规则），能当 JSON 解析就按 JSON 放。
 */
function parseQoderToolCall(value: string): QoderToolCall | undefined {
  const trimmed = value.trim()
  try {
    const framed = JSON.parse(trimmed) as {
      name?: unknown
      arguments?: unknown
    }
    if (
      framed
      && typeof framed === "object"
      && typeof framed.name === "string"
      && framed.name.trim()
    ) {
      // `arguments` 原样取用（Go 那边是 json.RawMessage）：能解析成对象才算数，
      // 否则掉到 XML 分支。
      const rawArgs =
        typeof framed.arguments === "string" ? framed.arguments
        : framed.arguments === undefined ? undefined
        : JSON.stringify(framed.arguments)
      if (rawArgs !== undefined) {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawArgs)
        } catch {
          parsed = undefined
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { name: framed.name.trim(), args: rawArgs.trim() }
        }
      }
    }
  } catch {
    // 不是 JSON 形态，继续走 XML。
  }

  const xml = parseXmlToolCall(value)
  if (!xml) return undefined
  return { name: xml.name, args: JSON.stringify(xml.arguments) }
}

/**
 * 流式拆分器：文本先攒着，直到一个完整的调用块到达再作为调用吐出。
 */
export class QoderToolCallSplitter {
  private textBuf = ""
  /** 调用块已收到的分片；闭合时才 join，避免逐帧复制整个缓冲。 */
  private callParts: Array<string> = []
  /** 已收内容的末尾（<= 标记长度 - 1），用来发现被切开的闭合标记。 */
  private callTail = ""
  private inCall = false
  /** 这段流里出现过 XML 形式的调用（用于判定 finish_reason）。 */
  sawTool = false

  feed(input: string): Array<QoderFragment> {
    const out: Array<QoderFragment> = []
    let rest = input
    while (rest !== "") {
      if (!this.inCall) {
        const combined = this.textBuf + rest
        this.textBuf = ""
        const at = combined.indexOf(CALL_OPEN)
        if (at < 0) {
          const keep = markerSuffix(combined)
          if (keep < combined.length) {
            out.push({
              kind: "text",
              text: combined.slice(0, combined.length - keep),
            })
            this.textBuf = combined.slice(combined.length - keep)
          } else {
            this.textBuf = combined
          }
          break
        }
        if (at > 0) {
          out.push({ kind: "text", text: combined.slice(0, at) })
        }
        rest = combined.slice(at + CALL_OPEN.length)
        this.inCall = true
        continue
      }

      const scan = this.callTail + rest
      const close = scan.indexOf(CALL_CLOSE)
      if (close < 0) {
        this.callParts.push(rest)
        this.callTail = scan.slice(-(CALL_CLOSE.length - 1))
        break
      }
      const closeAt = close - this.callTail.length
      const full = this.callParts.join("") + rest
      const body = full.slice(0, full.length - rest.length + closeAt)
      this.callParts = []
      this.callTail = ""
      const call = parseQoderToolCall(body)
      if (call) {
        this.sawTool = true
        out.push({ kind: "call", call })
      } else {
        out.push({ kind: "text", text: CALL_OPEN + body + CALL_CLOSE })
      }
      rest = rest.slice(closeAt + CALL_CLOSE.length)
      this.inCall = false
    }
    return out
  }

  /** 流结束：未闭合的调用按原文吐出，残余文本照发。 */
  flush(): Array<QoderFragment> {
    if (this.inCall) {
      const text = CALL_OPEN + this.callParts.join("")
      this.inCall = false
      this.callParts = []
      this.callTail = ""
      return [{ kind: "text", text }]
    }
    if (this.textBuf !== "") {
      const text = this.textBuf
      this.textBuf = ""
      return [{ kind: "text", text }]
    }
    return []
  }
}
