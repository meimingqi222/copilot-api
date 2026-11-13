import fs from "node:fs"
// magpie's tap on Claude Code's stream (internal/claudetui/tap.go). Claude
// Code, a Bun program, loads this before itself (BUN_OPTIONS --preload).
// Its requests to Anthropic go through Bun.FetchSession: this makes that
// a FetchSession whose fetch is the real one's, the request, connection
// and TLS untouched, and copies the reply of each of the main turn's
// requests (x-claude-code-request-class: main), as it streams, to the
// file COPILOT_API_CLAUDE_TAP names: a JSON line an event. Claude Code reads
// its own copy of the stream as before.
;(() => {
  const file = process.env.COPILOT_API_CLAUDE_TAP
  if (!file) return
  const effortFile = process.env.COPILOT_API_CLAUDE_EFFORT
  // none of it is handed on to what Claude Code runs, nor says it is here
  delete process.env.COPILOT_API_CLAUDE_TAP
  delete process.env.COPILOT_API_CLAUDE_PRELOAD
  delete process.env.COPILOT_API_CLAUDE_EFFORT
  const ours = /(^|\s)--preload(=|\s+)\S*\.copilot-tui-\S*/
  const opts = (process.env.BUN_OPTIONS || "").replace(ours, "").trim()
  if (opts) process.env.BUN_OPTIONS = opts
  else delete process.env.BUN_OPTIONS
  const argv = process.execArgv
  for (let i = argv.length - 1; i >= 0; i--) {
    if (!/\.copilot-tui-/.test(argv[i])) continue
    if (argv[i].startsWith("--preload=")) argv.splice(i, 1)
    else if (argv[i - 1] === "--preload") argv.splice(--i, 2)
  }

  let fd
  try {
    fd = fs.openSync(file, "a")
  } catch {
    return
  }
  const put = (v) => {
    try {
      fs.writeSync(fd, JSON.stringify(v) + "\n")
    } catch {}
  }
  const Real = globalThis.Bun && Bun.FetchSession
  if (typeof Real !== "function") {
    put({ tap: "none" })
    return
  }
  let streams = 0
  // read tells each event of stream s, then its end: cut when it broke
  // off, as a dropped connection or Claude Code's own Esc ends it
  const read = async (s, body) => {
    const dec = new TextDecoder()
    let buf = ""
    const event = (text) => {
      const data = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data) return
      let e
      try {
        e = JSON.parse(data)
      } catch {
        return
      }
      if (e && e.type !== "ping") put({ s, e })
    }
    try {
      for await (const chunk of body) {
        buf = (buf + dec.decode(chunk, { stream: true })).replace(
          /\r\n?/g,
          "\n",
        )
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          event(buf.slice(0, i))
          buf = buf.slice(i + 2)
        }
      }
      if (buf.trim()) event(buf)
      put({ s, end: "done" })
    } catch {
      put({ s, end: "cut" })
    }
  }
  class FetchSession extends Real {
    async fetch(input, init) {
      const url = String((input && input.url) || input)
      const headers = new Headers(
        (init && init.headers) || (input && input.headers) || undefined,
      )
      const main =
        headers.get("x-claude-code-request-class") === "main"
        && /\/v1\/messages(\?|$)/.test(url)
      if (main && effortFile) {
        const { effort } = JSON.parse(fs.readFileSync(effortFile, "utf8"))
        if (typeof effort === "string" && effort) {
          const body =
            typeof init?.body === "string" ? init.body
            : input instanceof Request && !init?.body ?
              await input.clone().text()
            : undefined
          if (body === undefined)
            throw new Error("Interactive effort requires a JSON request body")
          const payload = JSON.parse(body)
          init = {
            ...init,
            body: JSON.stringify({
              ...payload,
              output_config: { ...payload.output_config, effort },
            }),
          }
        }
        fs.writeFileSync(effortFile + ".live", "", { mode: 0o600 })
      }
      const res = await super.fetch(input, init)
      try {
        if (
          main
          && res.body
          && (res.headers.get("content-type") || "").startsWith(
            "text/event-stream",
          )
        ) {
          const [theirs, mine] = res.body.tee()
          Object.defineProperty(res, "body", {
            value: theirs,
            configurable: true,
          })
          // told before Claude Code has the reply, so the helper knows a
          // stream is coming before any of its messages
          const s = ++streams
          const h = Object.fromEntries(
            [...res.headers].filter(([name]) =>
              name.startsWith("anthropic-ratelimit-unified-"),
            ),
          )
          put({ s, open: true, h })
          read(s, mine)
        }
      } catch {}
      return res
    }
  }
  try {
    Bun.FetchSession = FetchSession
  } catch {}
  put({ tap: Bun.FetchSession === FetchSession ? "on" : "none" })
})()
