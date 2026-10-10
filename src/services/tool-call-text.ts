/**
 * 文本式工具调用解析。
 *
 * 有些上游（Qoder、Trae CN 等）不给原生 tools 字段，工具调用走文本协议，
 * 模型会把调用写进正文，形态有两种：
 *
 *   1. JSON: `<tool_call>{"name":"x","arguments":{...}}</tool_call>`
 *   2. XML : `<tool_call><function=x><parameter=k>v</parameter></function></tool_call>`
 *
 * 第 2 种是 Qoder / Trae IDE 插件共用的私有形态：模型被提示要求 JSON 时
 * 也会退回它。只认 JSON 的解析器会把整个块当普通文本透出，客户端就渲染成
 * 乱码工具调用 —— 所以两种形态都要认。
 *
 * 本模块只提供 XML 形态的解析。JSON 形态的接受条件各家不同（Qoder 要求
 * arguments 能解析成对象，Trae CN 走自己的归一化），由各自的调用方处理。
 */

export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"

const FUNCTION_RE = /<function=([^>]+)>([\s\S]*?)<\/function>/
const PARAMETER_RE = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g

interface ParsedXmlToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * 解析 XML 形态的调用块。`<function=name>` 缺失或名字为空返回 undefined。
 * 参数值原样取用（上游没有约定转义规则），能当 JSON 解析就按 JSON 放。
 */
export function parseXmlToolCall(value: string): ParsedXmlToolCall | undefined {
  const match = FUNCTION_RE.exec(value)
  if (!match) return undefined
  const name = (match[1] ?? "").trim()
  if (!name) return undefined

  const args: Record<string, unknown> = {}
  const body = match[2] ?? ""
  PARAMETER_RE.lastIndex = 0
  for (
    let param = PARAMETER_RE.exec(body);
    param;
    param = PARAMETER_RE.exec(body)
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
  return { name, arguments: args }
}
