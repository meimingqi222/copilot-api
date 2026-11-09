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

/** Tracks only the last thinking block, including a separately arriving type. */
export class WindsurfThinkingSignatures {
  private signature = ""
  private type = ""
  private bytes = 0
  private thinking = false

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
  }
}
