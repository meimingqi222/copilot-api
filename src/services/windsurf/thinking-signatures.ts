import { createHash } from "node:crypto"

// Messages signatures have no type field. Keep replay metadata provider-local,
// bounded by entries AND bytes; eviction safely falls back to Anthropic's type.
const signatures = new Map<string, string>()
const MAX_ENTRIES = 512
const MAX_BYTES = 4 * 1024 * 1024
let retainedBytes = 0

export function rememberWindsurfSignature(
  signature: string,
  type: string,
): void {
  if (!signature || !type) return
  const bytes = Buffer.byteLength(signature) + Buffer.byteLength(type)
  if (bytes > MAX_BYTES) return
  const previous = signatures.get(signature)
  if (previous !== undefined) {
    retainedBytes -= Buffer.byteLength(signature) + Buffer.byteLength(previous)
    signatures.delete(signature)
  }
  signatures.set(signature, type)
  retainedBytes += bytes
  while (signatures.size > MAX_ENTRIES || retainedBytes > MAX_BYTES) {
    const oldest = signatures.entries().next().value
    if (!oldest) break
    retainedBytes -= Buffer.byteLength(oldest[0]) + Buffer.byteLength(oldest[1])
    signatures.delete(oldest[0])
  }
}

export function getWindsurfSignatureType(signature: string): string {
  return signatures.get(signature) ?? "anthropic"
}

const thoughts = new Map<string, string>()
let thoughtBytes = 0
function thoughtKey(
  scope: string,
  model: string,
  callId: string,
  text: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        model,
        callId ? "call" : "text",
        callId || text.replace(/\s+/g, ""),
      ]),
    )
    .digest("hex")
}

/** Conversation/account and exact upstream SKU scoped: never replay another tenant's thought. */
export function getWindsurfGeminiThought(
  scope: string,
  model: string,
  callIds: Array<string>,
  text: string,
): string | undefined {
  if (!/gemini/i.test(model)) return undefined
  for (const id of callIds.length ? callIds
  : text ? [""]
  : []) {
    const signature = thoughts.get(thoughtKey(scope, model, id, text))
    if (signature) return signature
  }
  return undefined
}

/** Tracks only the last thinking block, including a separately arriving type. */
export class WindsurfThinkingSignatures {
  private signature = ""
  private type = ""
  private bytes = 0
  private thinking = false
  private geminiSignature = ""

  accept(kind: string, text = ""): void {
    if (kind === "reasoning_text") {
      if (!this.thinking) {
        this.signature = ""
        this.type = ""
        this.bytes = 0
      }
      this.thinking = true
    } else if (kind === "reasoning_signature") {
      this.bytes += Buffer.byteLength(text)
      // Never retain or register a truncated signature, but still forward SSE.
      this.signature = this.bytes <= MAX_BYTES ? this.signature + text : ""
    } else if (kind === "reasoning_signature_type") {
      this.type = Buffer.byteLength(text) <= 1024 ? text : ""
      rememberWindsurfSignature(this.signature, this.type)
    } else {
      if (this.thinking) rememberWindsurfSignature(this.signature, this.type)
      this.thinking = false
    }
    if (this.type === "gemini") this.geminiSignature = this.signature
  }

  rememberReply(
    scope: string,
    model: string,
    callIds: Array<string>,
    text: string,
  ): void {
    if (!/gemini/i.test(model) || !this.geminiSignature) return
    for (const id of callIds.length ? callIds
    : text ? [""]
    : []) {
      const key = thoughtKey(scope, model, id, text)
      const previous = thoughts.get(key)
      if (previous) thoughtBytes -= Buffer.byteLength(previous)
      thoughts.delete(key)
      thoughts.set(key, this.geminiSignature)
      thoughtBytes += Buffer.byteLength(this.geminiSignature)
      while (thoughts.size > MAX_ENTRIES || thoughtBytes > MAX_BYTES) {
        const oldest = thoughts.entries().next().value
        if (!oldest) break
        thoughtBytes -= Buffer.byteLength(oldest[1])
        thoughts.delete(oldest[0])
      }
    }
  }
}
