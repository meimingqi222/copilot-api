import { gunzipSync } from "node:zlib"

const textEncoder = new TextEncoder()
const INITIAL_ENCODER_CAPACITY = 64

function encodeVarintBytes(value: number): Uint8Array {
  const bytes: Array<number> = []
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return Uint8Array.from(bytes)
}

export class ProtobufEncoder {
  private buffer = new Uint8Array(0)
  private length = 0

  writeVarint(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, 0)
    this.appendPart(encodeVarintBytes(value))
  }

  writeBool(fieldNumber: number, value: boolean): void {
    this.writeVarint(fieldNumber, value ? 1 : 0)
  }

  writeString(fieldNumber: number, value: string): void {
    this.writeBytes(fieldNumber, textEncoder.encode(value))
  }

  writeBytes(fieldNumber: number, value: Uint8Array): void {
    this.writeTag(fieldNumber, 2)
    this.appendPart(encodeVarintBytes(value.length))
    this.appendPart(value)
  }

  writeMessage(fieldNumber: number, other: ProtobufEncoder): void {
    this.writeTag(fieldNumber, 2)
    const encoded = other.toUint8Array()
    this.appendPart(encodeVarintBytes(encoded.length))
    this.appendPart(encoded)
  }

  writeDouble(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, 1)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    this.appendPart(bytes)
  }

  /**
   * Returns a view over the encoded bytes without a final flattening copy.
   * Encoders are one-shot builders: callers should obtain this view after all
   * writes are complete and should not mutate the encoder afterwards.
   */
  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }

  private writeTag(fieldNumber: number, wireType: number): void {
    this.appendPart(encodeVarintBytes((fieldNumber << 3) | wireType))
  }

  private appendPart(part: Uint8Array): void {
    const required = this.length + part.length
    this.ensureCapacity(required)
    this.buffer.set(part, this.length)
    this.length = required
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length || INITIAL_ENCODER_CAPACITY
    while (capacity < required) {
      capacity *= 2
    }
    const next = new Uint8Array(capacity)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }
}

export function encodeConnectFrame(
  payload: Uint8Array,
  compressed = false,
): Uint8Array {
  const bytes =
    compressed ?
      (Bun.gzipSync(
        Buffer.from(
          payload.buffer as ArrayBuffer,
          payload.byteOffset,
          payload.byteLength,
        ),
      ) as unknown as Uint8Array)
    : payload
  const header = new Uint8Array(5)
  header[0] = compressed ? 1 : 0
  new DataView(header.buffer).setUint32(1, bytes.length, false)

  const framed = new Uint8Array(header.length + bytes.length)
  framed.set(header, 0)
  framed.set(bytes, header.length)
  return framed
}

/** Connect 帧 flag 位定义。 */
const CONNECT_COMPRESSED_FLAG = 0x01
const CONNECT_END_STREAM_FLAG = 0x02

/**
 * 单个 Connect 帧声明的最大 payload。
 * 参考 oh-my-pi 的 Devin provider,将上限从 64MB 收紧到 16MB:
 * 足够覆盖任何合法 Cascade 响应,同时让畸形/攻击性的 length 头快速失败,
 * 避免在 idle timeout 触发前缓冲数 GB 数据。
 */
const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024 // 16MB
/** 跨帧累积 buffer 的上限(完整帧会持续被消费,正常情况远低于此)。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024 // 32MB
/** gzip 展开后的单帧上限,防止压缩数据造成无界 native 分配。 */
const MAX_DECOMPRESSED_FRAME_PAYLOAD = 32 * 1024 * 1024 // 32MB

/**
 * 解析 Connect end-of-stream JSON trailer。
 * 当 trailer 携带 `{ error: { code, message } }` 时返回可读错误文本,
 * 否则返回 undefined。输入来自服务器,用 guard 而非断言检查结构。
 */
function readConnectTrailerError(text: string): string | undefined {
  if (text.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) {
    return undefined
  }
  const err = parsed.error
  if (!err || typeof err !== "object") return undefined
  const code = "code" in err && typeof err.code === "string" ? err.code : ""
  const message =
    "message" in err && typeof err.message === "string" ? err.message : ""
  if (!code && !message) return undefined
  return `Windsurf stream error${code ? ` ${code}` : ""}: ${message}`
}

export function decompressConnectPayload(payload: Uint8Array): Uint8Array {
  try {
    // Windsurf emits many small gzip frames. A Web Streams decompressor adds a
    // Response, reader, and concatenation buffer for every frame, which causes
    // a disproportionate native-memory spike in Bun. zlib performs one bounded
    // allocation and returns the decompressed bytes directly.
    return gunzipSync(payload, {
      maxOutputLength: MAX_DECOMPRESSED_FRAME_PAYLOAD,
    })
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ?
        (error as { code?: unknown }).code
      : undefined
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `decodeConnectFrames: decompressed frame exceeds limit ${MAX_DECOMPRESSED_FRAME_PAYLOAD}`,
      )
    }
    throw error
  }
}

function decodeConnectFramePayload(
  flags: number,
  payload: Uint8Array,
): Uint8Array | undefined {
  const raw =
    flags & CONNECT_COMPRESSED_FLAG ?
      decompressConnectPayload(payload)
    : payload

  if (flags & CONNECT_END_STREAM_FLAG) {
    const trailerError = readConnectTrailerError(
      Buffer.from(raw).toString("utf8").trim(),
    )
    if (trailerError) {
      throw new Error(trailerError)
    }
    return undefined
  }

  return raw
}

interface ConnectFrameDiagnostics {
  onFirstRead?: (bytes: number) => void
  onFirstFrame?: (bytes: number) => void
}

export async function* decodeConnectFrames(
  stream: ReadableStream<Uint8Array>,
  diagnostics?: ConnectFrameDiagnostics,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(0)
  let bufferStart = 0
  let bufferEnd = 0
  let sawRead = false
  let sawFrame = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!sawRead) {
        sawRead = true
        diagnostics?.onFirstRead?.(value.byteLength)
      }

      const pendingLength = bufferEnd - bufferStart
      const nextLength = pendingLength + value.byteLength
      // 防御:若 buffer 持续累积却无法凑齐一个完整帧(畸形 length 头或
      // 非 Connect 帧数据),直接抛错而非无限增长。
      if (nextLength > MAX_BUFFER_BYTES) {
        throw new Error(
          `decodeConnectFrames: buffer overflow (${nextLength} bytes) — `
            + `stream did not produce a complete frame within ${MAX_BUFFER_BYTES} bytes`,
        )
      }

      // Reuse a growable buffer. Repeatedly concatenating partial chunks also
      // creates an O(n^2) allocation pattern when a frame arrives slowly.
      if (bufferStart > 0 && buffer.length - bufferEnd < value.byteLength) {
        buffer.copyWithin(0, bufferStart, bufferEnd)
        bufferEnd = pendingLength
        bufferStart = 0
      }
      if (buffer.length - bufferEnd < value.byteLength) {
        const capacity = Math.min(
          MAX_BUFFER_BYTES,
          Math.max(nextLength, Math.max(1024, buffer.length * 2)),
        )
        const next = new Uint8Array(capacity)
        next.set(buffer.subarray(bufferStart, bufferEnd))
        buffer = next
        bufferStart = 0
        bufferEnd = pendingLength
      }
      buffer.set(value, bufferEnd)
      bufferEnd += value.byteLength

      let offset = bufferStart
      while (bufferEnd - offset >= 5) {
        const flags = buffer[offset]
        const length = new DataView(
          buffer.buffer,
          buffer.byteOffset + offset + 1,
          4,
        ).getUint32(0, false)
        // 畸形 length 头(声明远超合理上限的 payload):立即拒绝,
        // 否则 buffer 会一直累积直到凑齐该 length 才消费。
        if (length > MAX_FRAME_PAYLOAD) {
          throw new Error(
            `decodeConnectFrames: declared frame length ${length} exceeds limit ${MAX_FRAME_PAYLOAD}`,
          )
        }
        if (bufferEnd - offset < 5 + length) {
          break
        }

        const payload = buffer.slice(offset + 5, offset + 5 + length)
        offset += 5 + length

        // End-of-stream trailers are JSON metadata rather than protobuf.
        const decoded = decodeConnectFramePayload(flags, payload)
        if (!decoded) continue
        if (!sawFrame) diagnostics?.onFirstFrame?.(decoded.byteLength)
        sawFrame = true
        yield decoded
      }

      // Advance once per reader chunk, not once per frame. Re-slicing the
      // remaining buffer inside the loop turns a chunk containing many small
      // frames into an O(n^2) allocation pattern.
      bufferStart = offset
      if (bufferStart === bufferEnd) {
        bufferStart = 0
        bufferEnd = 0
      } else if (bufferStart > buffer.length / 2) {
        buffer.copyWithin(0, bufferStart, bufferEnd)
        bufferEnd -= bufferStart
        bufferStart = 0
      }
    }
  } finally {
    // A client disconnect can close the async generator before the upstream
    // response reaches EOF. Explicitly cancel the reader so the socket/body
    // is released instead of relying on fetch implementation details.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function readVarint(
  data: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } {
  let result = 0
  let shift = 0
  let currentOffset = offset

  while (currentOffset < data.length) {
    const byte = data[currentOffset] ?? 0
    currentOffset += 1
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: currentOffset }
    }
    shift += 7
  }

  throw new Error("Unexpected end of protobuf data")
}

export function extractStrings(data: Uint8Array): Array<string> {
  const decoder = new TextDecoder()
  const values: Array<string> = []
  let offset = 0

  while (offset < data.length) {
    let tag
    try {
      tag = readVarint(data, offset)
    } catch {
      break
    }
    offset = tag.nextOffset
    const wireType = tag.value & 0x7

    if (wireType === 0) {
      offset = readVarint(data, offset).nextOffset
      continue
    }

    if (wireType === 1) {
      offset += 8
      continue
    }

    if (wireType === 5) {
      offset += 4
      continue
    }

    if (wireType !== 2) {
      break
    }

    const lengthInfo = readVarint(data, offset)
    offset = lengthInfo.nextOffset
    const raw = data.slice(offset, offset + lengthInfo.value)
    offset += lengthInfo.value

    try {
      const text = decoder.decode(raw)
      if (text.length >= 2) {
        values.push(text)
      }
    } catch {
      continue
    }
  }

  return values
}

export interface ProtobufNode {
  field: number
  wire: number
  varint?: number
  raw?: Uint8Array
  sub?: Array<ProtobufNode>
}

export function parseMessage(
  data: Uint8Array,
  depth = 0,
  maxDepth = 9,
): Array<ProtobufNode> {
  const nodes: Array<ProtobufNode> = []
  let offset = 0

  while (offset < data.length) {
    let tagInfo
    try {
      tagInfo = readVarint(data, offset)
    } catch {
      break
    }
    offset = tagInfo.nextOffset
    const wire = tagInfo.value & 0x7
    const field = tagInfo.value >> 3
    const node: ProtobufNode = { field, wire }

    try {
      if (wire === 0) {
        const varintInfo = readVarint(data, offset)
        offset = varintInfo.nextOffset
        node.varint = varintInfo.value
        nodes.push(node)
        continue
      }

      if (wire === 1) {
        node.raw = data.subarray(offset, offset + 8)
        offset += 8
        nodes.push(node)
        continue
      }

      if (wire === 5) {
        node.raw = data.subarray(offset, offset + 4)
        offset += 4
        nodes.push(node)
        continue
      }

      if (wire !== 2) {
        break
      }

      const lengthInfo = readVarint(data, offset)
      offset = lengthInfo.nextOffset
      node.raw = data.subarray(offset, offset + lengthInfo.value)
      offset += lengthInfo.value

      if (depth < maxDepth && node.raw.length > 0) {
        const sub = parseMessage(node.raw, depth + 1, maxDepth)
        if (sub.length > 0) {
          node.sub = sub
        }
      }

      nodes.push(node)
    } catch {
      break
    }
  }

  return nodes
}

export function walkNodes(
  nodes: Array<ProtobufNode>,
  path = "",
): Array<{ path: string; node: ProtobufNode }> {
  return nodes.flatMap((node) => {
    const nextPath = `${path}/${node.field}`
    return [
      { path: nextPath, node },
      ...(node.sub ? walkNodes(node.sub, nextPath) : []),
    ]
  })
}
