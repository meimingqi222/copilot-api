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

export interface QoderToolCall {
  name: string
  args: string
}

export type QoderFragment =
  | { kind: "text"; text: string }
  | { kind: "call"; call: QoderToolCall }

const CALL_OPEN = "<tool_call>"
const CALL_CLOSE = "</tool_call>"

const FUNCTION_RE = /<function=([^>]+)>([\s\S]*?)<\/function>/
const PARAMETER_RE = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g

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
export function parseQoderToolCall(value: string): QoderToolCall | undefined {
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

  const match = FUNCTION_RE.exec(value)
  if (!match) return undefined
  const name = (match[1] ?? "").trim()
  if (!name) return undefined

  const args: Record<string, unknown> = {}
  PARAMETER_RE.lastIndex = 0
  for (
    let param = PARAMETER_RE.exec(match[2] ?? "");
    param;
    param = PARAMETER_RE.exec(match[2] ?? "")
  ) {
    const key = (param[1] ?? "").trim()
    if (!key) continue
    const raw = (param[2] ?? "").trim()
    try {
      args[key] = JSON.parse(raw) as unknown
    } catch {
      args[key] = raw
    }
  }
  return { name, args: JSON.stringify(args) }
}

/**
 * 流式拆分器：文本先攒着，直到一个完整的调用块到达再作为调用吐出。
 */
export class QoderToolCallSplitter {
  private textBuf = ""
  private callBuf = ""
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

      const combined = this.callBuf + rest
      this.callBuf = ""
      const close = combined.indexOf(CALL_CLOSE)
      if (close < 0) {
        this.callBuf = combined
        break
      }
      const call = parseQoderToolCall(combined.slice(0, close))
      if (call) {
        this.sawTool = true
        out.push({ kind: "call", call })
      } else {
        out.push({
          kind: "text",
          text: CALL_OPEN + combined.slice(0, close) + CALL_CLOSE,
        })
      }
      rest = combined.slice(close + CALL_CLOSE.length)
      this.inCall = false
    }
    return out
  }

  /** 流结束：未闭合的调用按原文吐出，残余文本照发。 */
  flush(): Array<QoderFragment> {
    if (this.inCall) {
      const text = CALL_OPEN + this.callBuf
      this.inCall = false
      this.callBuf = ""
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
