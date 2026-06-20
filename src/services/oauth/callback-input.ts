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
