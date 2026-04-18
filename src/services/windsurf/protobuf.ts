export class ProtobufEncoder {
  private chunks: Array<number> = []

  writeVarint(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, 0)
    this.pushVarint(value)
  }

  writeString(fieldNumber: number, value: string): void {
    this.writeBytes(fieldNumber, new TextEncoder().encode(value))
  }

  writeBytes(fieldNumber: number, value: Uint8Array): void {
    this.writeTag(fieldNumber, 2)
    this.pushVarint(value.length)
    this.chunks.push(...value)
  }

  writeMessage(fieldNumber: number, other: ProtobufEncoder): void {
    this.writeBytes(fieldNumber, other.toUint8Array())
  }

  writeDouble(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, 1)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    this.chunks.push(...bytes)
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }

  private writeTag(fieldNumber: number, wireType: number): void {
    this.pushVarint((fieldNumber << 3) | wireType)
  }

  private pushVarint(value: number): void {
    let remaining = value >>> 0
    while (remaining >= 0x80) {
      this.chunks.push((remaining & 0x7f) | 0x80)
      remaining >>>= 7
    }
    this.chunks.push(remaining)
  }
}

export function encodeConnectFrame(
  payload: Uint8Array,
  compressed = false,
): Uint8Array {
  const bytes =
    compressed ? new Uint8Array(Bun.gzipSync(Buffer.from(payload))) : payload
  const header = new Uint8Array(5)
  header[0] = compressed ? 1 : 0
  new DataView(header.buffer).setUint32(1, bytes.length, false)

  const framed = new Uint8Array(header.length + bytes.length)
  framed.set(header, 0)
  framed.set(bytes, header.length)
  return framed
}

export async function* decodeConnectFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  let buffer: Uint8Array = new Uint8Array(0) as Uint8Array

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer = concat(buffer, value)
    while (buffer.length >= 5) {
      const flags = buffer[0]
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset + 1,
        4,
      ).getUint32(0, false)
      if (buffer.length < 5 + length) {
        break
      }

      const payload = buffer.slice(5, 5 + length)
      buffer = buffer.slice(5 + length)
      yield flags === 1 || flags === 3 ?
        new Uint8Array(Bun.gunzipSync(Buffer.from(payload)))
      : payload
    }
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
        node.raw = data.slice(offset, offset + 8)
        offset += 8
        nodes.push(node)
        continue
      }

      if (wire === 5) {
        node.raw = data.slice(offset, offset + 4)
        offset += 4
        nodes.push(node)
        continue
      }

      if (wire !== 2) {
        break
      }

      const lengthInfo = readVarint(data, offset)
      offset = lengthInfo.nextOffset
      node.raw = data.slice(offset, offset + lengthInfo.value)
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

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length)
  merged.set(left, 0)
  merged.set(right, left.length)
  return merged as Uint8Array
}
