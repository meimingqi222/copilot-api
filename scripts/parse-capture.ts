/* eslint-disable unicorn/text-encoding-identifier-case, unicorn/prefer-switch */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

// Inline readVarint (avoid import issues with tsx)
function readVarint(
  data: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } {
  let result = 0,
    shift = 0,
    cur = offset
  while (cur < data.length) {
    const byte = data[cur]
    cur++
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, nextOffset: cur }
    shift += 7
  }
  throw new Error("Unexpected end")
}

const filePath =
  process.argv[2] ?? "D:/code/fast-context-mcp-py/data/GetChatMessage_request"
console.log("Parsing:", filePath)

const raw = new Uint8Array(readFileSync(filePath))
const flags = raw[0]
const length = new DataView(raw.buffer, 1, 4).getUint32(0, false)
console.log(`flags=${flags}, payload_length=${length}, file_size=${raw.length}`)

let payload = raw.slice(5, 5 + length)
if (flags === 1 || flags === 3) {
  payload = new Uint8Array(gunzipSync(Buffer.from(payload)))
  console.log(`Decompressed: ${payload.length} bytes`)
}

const decoder = new TextDecoder("utf-8", { fatal: true })
let offset = 0
while (offset < payload.length) {
  let tag
  try {
    tag = readVarint(payload, offset)
  } catch {
    break
  }
  offset = tag.nextOffset
  const wire = tag.value & 0x7
  const field = tag.value >> 3

  if (wire === 0) {
    const v = readVarint(payload, offset)
    offset = v.nextOffset
    console.log(`field=${field} wire=0 varint=${v.value}`)
  } else if (wire === 1) {
    const dv = new DataView(payload.buffer, payload.byteOffset + offset, 8)
    console.log(`field=${field} wire=1 float64=${dv.getFloat64(0, true)}`)
    offset += 8
  } else if (wire === 5) {
    offset += 4
    console.log(`field=${field} wire=5`)
  } else if (wire === 2) {
    const len = readVarint(payload, offset)
    offset = len.nextOffset
    const bytes = payload.slice(offset, offset + len.value)
    offset += len.value
    let preview: string
    try {
      const text = decoder.decode(bytes)
      preview = text.length > 120 ? text.slice(0, 120) + "..." : text
    } catch {
      preview = `<binary ${bytes.length}b>`
    }
    console.log(`field=${field} wire=2 len=${len.value} ${preview}`)
  } else {
    console.log(`field=${field} wire=${wire} UNKNOWN`)
    break
  }
}

process.exit(0)
