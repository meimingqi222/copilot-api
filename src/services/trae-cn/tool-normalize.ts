/**
 * Trae 工具调用的名字/参数归一（ported from magpie packages/trae）：
 *  - toolNamed：模型把工具名写成别的大小写/标点（Read→read）时归到请求声明的名字；
 *    请求没有的工具原样保留（让 agent 告知「无此工具」，而不是丢调用）。
 *  - unwrapped：模型把 arguments 又裹了一层 {arguments:{…}} 时脱掉（工具无该参数名时）。
 *  - nameCall：GLM/客户端把整段调用写进 native call 的 name（服务在标签处截断的交接）时读出来。
 *
 * escapeRaw 只转义 JSON 字符串内的裸控制字符，绝不重解路径反斜杠——
 * 与 trae-text-tool-integrity 笔记一致。
 */

const WRAPS = ["arguments", "input", "parameters", "args"]

function toolName(t: unknown): string {
  const entry = (t ?? {}) as Record<string, unknown>
  const fn = (entry.function ?? entry) as Record<string, unknown>
  return typeof fn?.name === "string" ? fn.name : ""
}

function toolProps(
  tools: ReadonlyArray<unknown>,
  name: string,
): Record<string, unknown> {
  const t = tools
    .map((x) => (x ?? {}) as Record<string, unknown>)
    .map((x) => (x.function ?? x) as Record<string, unknown>)
    .find((f) => f?.name === name)
  const params = (t?.parameters ?? {}) as Record<string, unknown>
  return (params.properties ?? {}) as Record<string, unknown>
}

/** 请求声明的工具名（大小写/标点归一）；无匹配则原样。 */
export function traeToolNamed(
  name: string,
  tools: ReadonlyArray<unknown>,
): string {
  const names = tools.map(toolName).filter(Boolean)
  if (!names.length || names.includes(name)) return name
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "")
  return names.find((n) => norm(n) === norm(name)) ?? name
}

/** 只转义 JSON 字符串内的裸控制字符（不动反斜杠/路径）。 */
function escapeRaw(s: unknown): string {
  let out = ""
  let str = false
  let esc = false
  for (const ch of String(s ?? "")) {
    if (str && !esc && ch < " ") {
      out +=
        ch === "\n" ? "\\n"
        : ch === "\r" ? "\\r"
        : ch === "\t" ? "\\t"
        : "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
      continue
    }
    if (str && ch === "\\" && !esc) esc = true
    else {
      if (ch === '"' && !esc) str = !str
      esc = false
    }
    out += ch
  }
  return out
}

/** 宽松读一个 JSON 对象（先原样，再只修裸控制字符）；不是对象则 null。 */
export function looseJSON(s: unknown): Record<string, unknown> | null {
  for (const t of [String(s ?? ""), escapeRaw(s)]) {
    try {
      const v = JSON.parse(t)
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>
      }
    } catch {
      /* try the bounded repair */
    }
  }
  return null
}

/** 脱掉模型多裹的 {arguments:{…}} 层（工具无该参数名时）；args 是字符串。 */
export function traeUnwrapped(
  args: string,
  name: string,
  tools: ReadonlyArray<unknown>,
): string {
  if (!tools.some((tool) => toolName(tool) === name)) return args
  const props = toolProps(tools, name)
  let v = looseJSON(args)
  let changed = false
  for (
    let k = 0;
    k < 3 && v && typeof v === "object" && !Array.isArray(v);
    k++
  ) {
    const keys = Object.keys(v)
    if (keys.length !== 1 || !WRAPS.includes(keys[0]!) || keys[0]! in props) {
      break
    }
    let inner: unknown = v[keys[0]!]
    if (typeof inner === "string") inner = looseJSON(inner)
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) break
    v = inner as Record<string, unknown>
    changed = true
  }
  return changed ? JSON.stringify(v) : args
}

// ── nameCall：name 里写着的整段调用（GLM/客户端交接） ──────────────

const NAMECALL =
  /^\s*\{\s*"name"\s*:\s*"([^"\\]*)"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*\{/
const NAMEHEAD =
  /\{\s*"name"\s*:\s*"([^"\\]*)"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*\{/

function decode(src: string): string {
  try {
    return JSON.parse('"' + escapeRaw(src) + '"')
  } catch {
    return src
  }
}

function endsValue(rest: string): boolean {
  if (/^\s*(?:[,}\]$]|<\/?[a-z_]+\s*>)/.test(rest)) return true
  return /^\s*"(?:[^"\\]|\\.)*"\s*(?::|<\/?[a-z_]+\s*>)/.test(rest)
}

function valueEnd(rest: string): number {
  const stops = [
    rest.search(
      /"(?:(?:[^"\\<>]*)"\s*(?::|,|\s*<\/?[a-z_]+\s*>)|[^"\\<>]*<\/?[a-z_]+\s*>)/,
    ),
    rest.search(/<\/?[a-z_]+\s*>/),
    rest.search(/[}\]]/),
  ].filter((x) => x >= 0)
  return stops.length ? Math.min(...stops) : rest.length
}

function nameString(
  s: string,
  i: number,
  ends: (rest: string) => boolean,
): { text: string; i: number; closed: boolean } {
  i++ // opening quote
  let src = ""
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "\\") {
      src += s[i]! + (s[i + 1] ?? "")
      i += 2
      continue
    }
    if (ch === "<" && /^<\/?[a-z_][\w-]*\s*>/.test(s.slice(i))) break
    if (ch === '"') {
      if (ends(s.slice(i + 1))) {
        i++
        return { text: decode(src), i, closed: true }
      }
      src += '\\"'
      i++
      continue
    }
    src += ch
    i++
  }
  return { text: decode(src), i, closed: false }
}

function nameFields(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let i = 0
  for (let n = 0; n < 64 && i < body.length; n++) {
    i += (body.slice(i).match(/^[\s,]+|^<\/?[a-z_]+\s*>/) || [""])[0]!.length
    if (body[i] !== '"') break
    const key = nameString(body, i, () => true)
    i = key.i
    if (!key.text) break
    const colon = body.slice(i).match(/^\s*:\s*/)
    if (colon) i += colon[0].length
    i += (body.slice(i).match(/^(?:<\/?[a-z_]+\s*>)+/) || [""])[0]!.length
    let value: string
    if (body[i] === '"') {
      const v = nameString(body, i, (rest) => endsValue(rest))
      value = v.text
      i = v.i
      if (!value && !v.closed) break
    } else {
      const rest = body.slice(i)
      const stop = valueEnd(rest)
      value = rest
        .slice(0, stop)
        .replace(/^[\s,:]+/, "")
        .replace(/[\s,}\]]+$/, "")
        .replace(/(?<!\\)"$/, "")
        .replace(/[\s,}\]]+$/, "")
      i += stop
      if (!value) break
    }
    out.push([key.text, value])
  }
  return out
}

/**
 * name 里写着的调用（{name, arguments}），不是则 null：无 wrapper、工具不在
 * 请求里、或读不出任何字段。wrapper 与标签是服务自己的交接，其间是模型的
 * 原文（未转义的引号按引号读，值在标签处截断）。
 */
export function traeNameCall(
  s: unknown,
  tools: ReadonlyArray<unknown> = [],
): { name: string; arguments: Record<string, unknown> } | null {
  const text = String(s ?? "")
  const at = text.indexOf("{")
  if (at < 0) return null
  const m = NAMECALL.exec(text.slice(at))
  if (!m) return null
  const name = m[1]!
  const props = toolProps(tools, name)
  const declared = tools.map(toolName).filter(Boolean)
  if (!declared.includes(name)) return null
  const fields = nameFields(text.slice(at + m[0].length))
  const args: Record<string, unknown> = {}
  for (const [key, value] of fields) {
    const prop = props[key] as Record<string, unknown> | undefined
    if (prop?.type !== "string") {
      try {
        args[key] = JSON.parse(value.trim())
        continue
      } catch {
        /* keep the text */
      }
    }
    args[key] = value
  }
  return Object.keys(args).length ? { name, arguments: args } : null
}

/** name 是否带着 GLM 交接的 wrapper（供 native call 判定）。 */
export function traeNameHasWrapper(name: string): boolean {
  return NAMEHEAD.test(name) || name.includes("<arg_key>")
}
