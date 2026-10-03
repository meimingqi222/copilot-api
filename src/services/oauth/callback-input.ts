function readQueryLikeCallbackInput(value: string): URLSearchParams | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const queryStart = trimmed.indexOf("?")
  const hashStart = trimmed.indexOf("#")
  let rawParams = trimmed
  if (queryStart !== -1) {
    rawParams = trimmed.slice(queryStart + 1)
  } else if (hashStart !== -1) {
    rawParams = trimmed.slice(hashStart + 1)
  }

  if (!/(?:^|[&#?])(?:code|state|error)=/i.test(rawParams)) {
    return null
  }

  return new URLSearchParams(rawParams.replace(/^[?#]/, ""))
}

function extractDisplayedCode(value: string): string {
  const trimmed = value.trim()
  const codeMatch = trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i)
  return (codeMatch?.[1] ?? trimmed).trim()
}

/**
 * 把粘贴的回调输入按 URLSearchParams 读出来：支持完整 URL（query 或
 * hash 段）、裸查询串。与标准 code/state 解析共用这一层。
 */
function callbackParams(input: string): URLSearchParams | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const raw = url.search || url.hash
    if (raw) return new URLSearchParams(raw.replace(/^[?#]/, ""))
  } catch {
    // Not an absolute URL — fall through to the query-like parser.
  }
  const queryStart = trimmed.indexOf("?")
  const hashStart = trimmed.indexOf("#")
  let raw = trimmed
  if (queryStart !== -1) {
    raw = trimmed.slice(queryStart + 1)
  } else if (hashStart !== -1) {
    raw = trimmed.slice(hashStart + 1)
  }
  if (!raw.includes("=")) return null
  return new URLSearchParams(raw.replace(/^[?#]/, ""))
}

/**
 * 按 provider 自己的回调配置解析粘贴的回调地址。
 *
 * 回调参数名不一定是标准的 code/state（Trae CN 带的是
 * `userJwt`/`userInfo`），且有的 provider 要把两个值拼成
 * `<state>\u0000<code>` 交给 exchange——与 loopback 回调服务器里
 * `combineIntoCode` 的行为完全一致。参数缺失或不匹配时返回 undefined，
 * 调用方再回退到标准解析。
 */
export function parseProviderCallbackInput(
  input: string,
  config: {
    queryParams?: { code: string; state: string }
    combineIntoCode?: boolean
  },
): string | undefined {
  const params = callbackParams(input)
  if (!params) return undefined
  const codeParam = config.queryParams?.code ?? "code"
  const code = params.get(codeParam)?.trim()
  if (!code) return undefined
  if (!config.combineIntoCode) return code
  // state 段缺失时按空串处理（Trae CN 的 userInfo 可以缺省）。
  const stateParam = config.queryParams?.state ?? "state"
  const state = params.get(stateParam)?.trim() ?? ""
  return `${state}\u0000${code}`
}

export function parseOAuthAuthorizationCode(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code")?.trim()
    if (code) {
      return code
    }
  } catch {
    // Not an absolute URL — fall through to other parsers.
  }

  const params = readQueryLikeCallbackInput(trimmed)
  if (params) {
    const code = params.get("code")?.trim()
    if (code) {
      return code
    }
  }

  const displayed = extractDisplayedCode(trimmed)
  if (displayed && displayed.length >= 8) {
    return displayed
  }

  return undefined
}
