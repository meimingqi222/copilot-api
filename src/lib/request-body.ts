import { HTTPError } from "~/lib/error"

const DEFAULT_JSON_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_MEDIA_JSON_BODY_BYTES = 64 * 1024 * 1024
const DEFAULT_FORM_BODY_BYTES = 1024 * 1024

function readLimit(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export const MAX_JSON_BODY_BYTES = readLimit(
  "MAX_JSON_BODY_BYTES",
  DEFAULT_JSON_BODY_BYTES,
)
export const MAX_MEDIA_JSON_BODY_BYTES = readLimit(
  "MAX_MEDIA_JSON_BODY_BYTES",
  DEFAULT_MEDIA_JSON_BODY_BYTES,
)
export const MAX_FORM_BODY_BYTES = readLimit(
  "MAX_FORM_BODY_BYTES",
  DEFAULT_FORM_BODY_BYTES,
)

function bodyTooLarge(maxBytes: number): HTTPError {
  return new HTTPError(
    `Request body exceeds the ${maxBytes}-byte limit`,
    new Response(null, { status: 413 }),
  )
}

/** Read and parse JSON without allowing a chunked body to grow without bound. */
export async function readJsonBody<T>(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T> {
  assertDeclaredBodySize(request.headers, maxBytes)
  const bytes = await readBodyBytes(request.body, maxBytes)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

export async function readTextBody(
  request: Request,
  maxBytes = MAX_FORM_BODY_BYTES,
): Promise<string> {
  assertDeclaredBodySize(request.headers, maxBytes)
  const bytes = await readBodyBytes(request.body, maxBytes)
  return new TextDecoder().decode(bytes)
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  assertDeclaredBodySize(response.headers, maxBytes)
  return readBodyBytes(response.body, maxBytes)
}

function assertDeclaredBodySize(headers: Headers, maxBytes: number): void {
  const contentLength = headers.get("content-length")
  if (!contentLength) return
  const declared = Number(contentLength)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw bodyTooLarge(maxBytes)
  }
}

async function readBodyBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0)
  const reader = (body as unknown as ReadableStream<Uint8Array>).getReader()
  let bytes = new Uint8Array(Math.min(64 * 1024, maxBytes))
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const nextLength = totalBytes + value.byteLength
      if (nextLength > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw bodyTooLarge(maxBytes)
      }
      if (nextLength > bytes.length) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextLength, Math.max(bytes.length * 2, 64 * 1024)),
        )
        const next = new Uint8Array(nextCapacity)
        next.set(bytes.subarray(0, totalBytes))
        bytes = next
      }
      bytes.set(value, totalBytes)
      totalBytes = nextLength
    }
  } finally {
    reader.releaseLock()
  }
  return bytes.subarray(0, totalBytes)
}
