const HEADER = '{"input":"'
// oxlint-disable-next-line no-control-regex -- JSON strings reject unescaped U+0000 through U+001F.
const STRING_BOUNDARY = /["\\\u0000-\u001f]/g
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

type Phase = "header" | "text" | "escape" | "unicode" | "done" | "invalid"

/** Decodes only new argument bytes; full JSON validation stays at tool completion. */
export class CustomToolInputDecoder {
  private phase: Phase = "header"
  private headerOffset = 0
  private unicode = ""
  private highSurrogate = ""
  /** Already emitted input, kept as a rope until the final consistency check. */
  value = ""

  push(delta: string): string | undefined {
    if (this.phase === "invalid") return undefined
    if (this.phase === "done") return ""
    const fragments = [this.highSurrogate]
    let offset = 0
    while (offset < delta.length) {
      if (this.phase === "header") {
        this.readHeader(delta[offset++])
      } else if (this.phase === "text") {
        STRING_BOUNDARY.lastIndex = offset
        const boundary = STRING_BOUNDARY.exec(delta)
        const end = boundary?.index ?? delta.length
        fragments.push(delta.slice(offset, end))
        offset = end
        if (!boundary) break
        const char = delta[offset++]
        if (char === '"') {
          this.phase = "done"
          break
        }
        this.phase = char === "\\" ? "escape" : "invalid"
      } else if (this.phase === "escape") {
        const char = delta[offset++]
        if (char === "u") {
          this.phase = "unicode"
          this.unicode = ""
        } else if (ESCAPES[char] !== undefined) {
          fragments.push(ESCAPES[char])
          this.phase = "text"
        } else this.phase = "invalid"
      } else if (this.phase === "unicode") {
        const char = delta[offset++]
        if (!/[\da-f]/i.test(char)) this.phase = "invalid"
        else {
          this.unicode += char
          if (this.unicode.length === 4) {
            fragments.push(
              String.fromCharCode(Number.parseInt(this.unicode, 16)),
            )
            this.phase = "text"
          }
        }
      }
      if (this.phase === "invalid") return undefined
    }
    if (this.phase === "header") return undefined
    let text = fragments.join("")
    const last = text.charCodeAt(text.length - 1)
    this.highSurrogate = ""
    if (last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = text.slice(-1)
      text = text.slice(0, -1)
    }
    this.value += text
    return text
  }

  private readHeader(char: string): void {
    if (
      (this.headerOffset === 0
        || this.headerOffset === 1
        || this.headerOffset === 8
        || this.headerOffset === 9)
      && /\s/.test(char)
    )
      return
    if (char !== HEADER[this.headerOffset]) {
      this.phase = "invalid"
      return
    }
    if (++this.headerOffset === HEADER.length) this.phase = "text"
  }
}
