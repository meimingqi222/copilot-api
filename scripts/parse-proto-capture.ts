/* eslint-disable unicorn/text-encoding-identifier-case */
/**
 * Deep parser for Windsurf GetChatMessage request & response captures.
 * Usage: bun run scripts/parse-proto-capture.ts <temp/GetChatMessage-req|res>
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

// ── Varint ───────────────────────────────────────────────────────────

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
  throw new Error("Unexpected end of varint data")
}

function parseFloat64(raw: Uint8Array): number {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat64(
    0,
    true,
  )
}

function tryDecodeUTF8(raw: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    return undefined
  }
}

// ── Struct printer ───────────────────────────────────────────────────

interface StructNode {
  field: number
  wire: number
  varint?: number
  float64?: number
  str?: string
  raw?: string
  sub?: Array<StructNode>
  description?: string
}

class StructBuilder {
  nodes: Array<StructNode> = []

  append(node: StructNode): void {
    this.nodes.push(node)
  }

  walk(data: Uint8Array, depth = 0): number {
    let offset = 0
    while (offset < data.length) {
      let tag
      try {
        tag = readVarint(data, offset)
      } catch {
        break
      }
      offset = tag.nextOffset
      const wire = tag.value & 0x7
      const field = tag.value >> 3
      const node: StructNode = { field, wire }

      switch (wire) {
        case 0: {
          const vi = readVarint(data, offset)
          offset = vi.nextOffset
          node.varint = vi.value
          break
        }
        case 1: {
          if (offset + 8 <= data.length) {
            node.float64 = parseFloat64(data.slice(offset, offset + 8))
            offset += 8
          } else {
            break
          }
          break
        }
        case 2: {
          const lenInfo = readVarint(data, offset)
          offset = lenInfo.nextOffset
          if (offset + lenInfo.value > data.length) break
          const raw = data.slice(offset, offset + lenInfo.value)
          offset += lenInfo.value

          const text = tryDecodeUTF8(raw)
          if (text !== undefined) {
            node.str = text.length > 300 ? text.slice(0, 300) + "…" : text
          } else {
            const hexBytes = Array.from(raw.slice(0, 32))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
            node.raw = `[${raw.length}B] ${hexBytes}`
          }
          if (depth < 4) {
            const inner = new StructBuilder()
            inner.walk(raw, depth + 1)
            node.sub = inner.nodes
          }
          break
        }
        case 5: {
          if (offset + 4 <= data.length) {
            node.raw = `[float32] ${new DataView(
              data.buffer,
              data.byteOffset + offset,
              4,
            ).getFloat32(0, true)}`
            offset += 4
          }
          break
        }
        default: {
          break // unknown wire type
        }
      }
      this.nodes.push(node)
    }
    return offset
  }
}

// ── Pretty printer ───────────────────────────────────────────────────

const FIELD_NAMES_REQ: Record<number, string> = {
  1: "metadata",
  2: "system_prompt",
  3: "messages",
  7: "mode",
  8: "sampling",
  10: "tools",
  15: "trace_info",
  16: "request_id",
  20: "field_20",
  21: "model",
  22: "session_id",
}

const FIELD_NAMES_MSG: Record<number, string> = {
  2: "role (1=user,2=assistant,4=tool)",
  3: "content",
  6: "tool_calls",
  7: "tool_call_id",
  11: "reasoning_text",
}

const FIELD_NAMES_RES: Record<number, string> = {
  1: "conversation_id",
  2: "timestamps",
  3: "content_delta",
  4: "status_code",
  5: "done_flag",
  7: "metadata",
  12: "temperature",
  13: "header_entry",
  17: "session_id",
  28: "sections",
  33: "cached_tokens",
}

function fieldDesc(field: number, map: Record<number, string>): string {
  const desc = map[field]
  return desc ? ` (${desc})` : ""
}

function printTree(
  nodes: Array<StructNode>,
  indent = 0,
  fieldMap: Record<number, string> = {},
  isResponse = false,
): void {
  const pad = "  ".repeat(indent)
  for (const node of nodes) {
    const desc = fieldDesc(node.field, fieldMap)
    let line = `${pad}f${node.field}${desc}: `
    switch (node.wire) {
      case 0: {
        line += `varint = ${node.varint}`

        break
      }
      case 1: {
        line += `float64 = ${node.float64}`

        break
      }
      case 2: {
        if (node.raw) {
          line += node.raw
        } else if (node.str !== undefined) {
          line += `"${node.str}"`
        }

        break
      }
      case 5: {
        line += node.raw ?? "float32"

        break
      }
      default: {
        line += `<wire=${node.wire}>`
      }
    }
    console.log(line)
    if (node.sub && node.sub.length > 0) {
      const subMap =
        node.field === 3 && !isResponse ? FIELD_NAMES_MSG : fieldMap
      printTree(node.sub, indent + 1, subMap, isResponse)
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error("Usage: bun run scripts/parse-proto-capture.ts <file>")
    process.exit(1)
  }

  const isResponse = filePath.toLowerCase().includes("res")
  console.log(`Parsing: ${filePath} (${isResponse ? "response" : "request"})\n`)

  const raw = new Uint8Array(readFileSync(filePath))

  // Parse Connect frames
  let offset = 0
  let frameNum = 0
  const totalFrames: Array<Array<StructNode>> = []

  while (offset + 5 <= raw.length) {
    const flags = raw[offset]
    const length =
      ((raw[offset + 1] ?? 0) << 24)
      | ((raw[offset + 2] ?? 0) << 16)
      | ((raw[offset + 3] ?? 0) << 8)
      | (raw[offset + 4] ?? 0)

    if (length < 1 || length > 10_000_000) break
    if (offset + 5 + length > raw.length) break

    let payload = raw.slice(offset + 5, offset + 5 + length)
    if (flags === 1 || flags === 3) {
      payload = new Uint8Array(gunzipSync(Buffer.from(payload)))
    }

    frameNum++
    const builder = new StructBuilder()
    builder.walk(payload)
    totalFrames.push(builder.nodes)

    const map = isResponse ? FIELD_NAMES_RES : FIELD_NAMES_REQ

    if (frameNum <= 5 || frameNum === totalFrames.length) {
      console.log(
        `── Frame ${frameNum} (flags=${flags}, len=${length}, decomp=${payload.length}) ──`,
      )
      printTree(builder.nodes, 0, map, isResponse)
      console.log()
    }
    offset += 5 + length
  }

  if (frameNum > 5) {
    console.log(
      `\n[${frameNum - 1} frames hidden; showing first 5 and last one above]`,
    )
  }
  console.log(`Total frames: ${frameNum}`)
}

main()
