import { parseMessage } from "~/services/windsurf/protobuf"

const METADATA_STRING_FIELDS = new Set([
  1, 2, 4, 5, 7, 10, 12, 21, 25, 26, 28, 31,
])

export interface WindsurfRequestFingerprint {
  metadataFields: Array<number>
  metadata: Record<string, string | number>
  mode?: number
  requestType?: number
  toolCount: number
  messageCount: number
  model?: string
  cascadeId?: string
  promptId?: string
  hasSystemPrompt: boolean
  hasTrace: boolean
  samplingFields: Array<number>
}

function decodeConnectPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 5) return framed
  const flags = framed[0]
  const payload = framed.subarray(5)
  if (flags === 1 || flags === 3) {
    return new Uint8Array(Bun.gunzipSync(Buffer.from(payload)))
  }
  return payload
}

function readStringField(
  nodes: ReturnType<typeof parseMessage>,
  field: number,
): string | undefined {
  const node = nodes.find((n) => n.field === field && n.raw)
  if (!node?.raw) return undefined
  return new TextDecoder().decode(node.raw)
}

/** Summarize top-level GetChatMessage request fields for log comparison. */
export function fingerprintWindsurfRequest(
  framedRequest: Uint8Array,
): WindsurfRequestFingerprint {
  const nodes = parseMessage(decodeConnectPayload(framedRequest), 0, 6)
  const metadataNode = nodes.find((n) => n.field === 1 && n.sub)
  const metadataFields =
    metadataNode?.sub?.map((n) => n.field).sort((a, b) => a - b) ?? []
  const metadata: Record<string, string | number> = {}

  for (const sub of metadataNode?.sub ?? []) {
    if (sub.varint !== undefined && sub.field === 9) {
      metadata.request_id = sub.varint
    }
    if (sub.raw && METADATA_STRING_FIELDS.has(sub.field)) {
      const value = new TextDecoder().decode(sub.raw)
      metadata[`f${sub.field}`] =
        sub.field === 3 ? `${value.slice(0, 24)}…` : value.slice(0, 80)
    }
  }

  const samplingNode = nodes.find((n) => n.field === 8 && n.sub)
  return {
    metadataFields,
    metadata,
    mode: nodes.find((n) => n.field === 7)?.varint,
    requestType: nodes.find((n) => n.field === 20)?.varint,
    toolCount: nodes.filter((n) => n.field === 10).length,
    messageCount: nodes.filter((n) => n.field === 3).length,
    model: readStringField(nodes, 21),
    cascadeId: readStringField(nodes, 16),
    promptId: readStringField(nodes, 22),
    hasSystemPrompt: nodes.some((n) => n.field === 2 && n.raw),
    hasTrace: nodes.some((n) => n.field === 15),
    samplingFields:
      samplingNode?.sub?.map((n) => n.field).sort((a, b) => a - b) ?? [],
  }
}

export interface ProtoFieldDiff {
  onlyInCapture: Array<number>
  onlyInBuilt: Array<number>
  shared: Array<number>
}

/** Compare metadata / top-level field numbers between capture and built request. */
export function diffProtoFieldSets(
  captureFields: Array<number>,
  builtFields: Array<number>,
): ProtoFieldDiff {
  const capture = new Set(captureFields)
  const built = new Set(builtFields)
  const onlyInCapture = [...capture]
    .filter((f) => !built.has(f))
    .sort((a, b) => a - b)
  const onlyInBuilt = [...built]
    .filter((f) => !capture.has(f))
    .sort((a, b) => a - b)
  const shared = [...capture].filter((f) => built.has(f)).sort((a, b) => a - b)
  return { onlyInCapture, onlyInBuilt, shared }
}
