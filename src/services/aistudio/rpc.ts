/** JSON+protobuf permits sparse array slots, unlike ordinary JSON. */
export function parseRpcJson(source: string): unknown {
  let quoted = false
  let escaped = false
  let previous = ""
  const output: string[] = []
  for (const char of source) {
    if (quoted) {
      output.push(char)
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    if (
      (char === "," && (previous === "[" || previous === ","))
      || (char === "]" && previous === ",")
    )
      output.push("null")
    output.push(char)
    if (!/\s/.test(char)) previous = char
  }
  return JSON.parse(output.join("")) as unknown
}

export function loggingContextHeader(value: unknown): string {
  if (!Array.isArray(value))
    throw new Error("Invalid AI Studio logging context")
  const bytes: number[] = []
  const varint = (input: bigint) => {
    let n = BigInt.asUintN(64, input)
    do {
      const byte = Number(n & 127n)
      n >>= 7n
      bytes.push(byte | (n ? 128 : 0))
    } while (n)
  }
  value.forEach((item: unknown, index) => {
    if (item === null || item === undefined) return
    const field = BigInt((index + 1) * 8)
    if (typeof item === "string") {
      const text = Buffer.from(item)
      varint(field | 2n)
      varint(BigInt(text.length))
      for (const byte of text) bytes.push(byte)
    } else if (
      typeof item === "boolean"
      || (typeof item === "number" && Number.isSafeInteger(item))
    ) {
      varint(field)
      varint(
        typeof item === "boolean" ?
          item ? 1n
          : 0n
        : BigInt(item),
      )
    } else throw new Error("Invalid AI Studio logging context field")
  })
  return Buffer.from(bytes).toString("base64")
}
