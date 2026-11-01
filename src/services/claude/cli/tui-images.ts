import { lookup } from "node:dns/promises"
import type { LookupAddress } from "node:dns"
import fs from "node:fs/promises"
import { BlockList, isIP } from "node:net"
import path from "node:path"
// Bun's built-in undici Agent ignores custom connectors; load the npm implementation.
import { Agent, request } from "undici/index.js"

import type { AnthropicImageSource } from "~/services/protocols/anthropic/types"

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_CACHE_BYTES = 20 * 1024 * 1024
const privateV4 = new BlockList()
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(ip, bits)
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
const privateV6 = new BlockList()
for (const [ip, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  privateV6.addSubnet(ip, bits, "ipv6")

/** Reject local, mapped, multicast and reserved destinations before connecting. */
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) return !privateV4.check(address)
  return (
    isIP(address) === 6
    && globalV6.check(address, "ipv6")
    && !privateV6.check(address, "ipv6")
  )
}

function imageUrl(raw: string): URL {
  const url = new URL(raw)
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  )
    throw new Error("Image URL must use HTTP(S) without credentials")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) && !isPublicImageAddress(host))
    throw new Error("Image URL must resolve to public addresses")
  return url
}

/** A mixed DNS answer may be used only through its checked public addresses. */
export async function publicImageAddresses(
  host: string,
): Promise<Array<LookupAddress>> {
  const addresses = (await lookup(host, { all: true })).filter(({ address }) =>
    isPublicImageAddress(address),
  )
  if (!addresses.length)
    throw new Error("Image URL must resolve to public addresses")
  return addresses
}

/** Pin checked DNS results at the socket, including every redirect's destination. */
async function downloadImage(
  raw: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const dispatcher = new Agent({
    connect: {
      lookup(host, options, callback) {
        void publicImageAddresses(host)
          .then((addresses) => {
            const family =
              typeof options === "number" ? options : options.family
            const candidates = addresses.filter(
              (item) => !family || item.family === family,
            )
            if (!candidates.length)
              throw new Error("Image URL has no usable public address")
            if (typeof options === "object" && options.all)
              callback(null, candidates)
            else callback(null, candidates[0].address, candidates[0].family)
          })
          .catch((error: unknown) =>
            callback(
              error instanceof Error ? error : new Error("Image DNS failed"),
              "",
              4,
            ),
          )
      },
    },
  })
  try {
    let url = imageUrl(raw)
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted()
      const response = await request(url, {
        dispatcher,
        signal,
        headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
      })
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location
          if (typeof location !== "string" || redirects === 3)
            throw new Error("Image redirect limit exceeded")
          url = imageUrl(new URL(location, url).href)
          continue
        }
        if (response.statusCode !== 200)
          throw new Error(`Image download returned HTTP ${response.statusCode}`)
        if (Number(response.headers["content-length"]) > MAX_IMAGE_BYTES)
          throw new Error("Image exceeds 5 MB")
        const chunks: Array<Buffer> = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 5 MB")
          chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      } finally {
        response.body.destroy()
      }
    }
    throw new Error("Image redirect limit exceeded")
  } finally {
    await dispatcher.destroy()
  }
}

/** Inspect bytes rather than trusting the URL extension or the declared MIME type. */
export function claudeImageExtension(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Image must contain at most 5 MB")
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg"
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif"
  if (
    bytes.subarray(0, 4).toString() === "RIFF"
    && bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "webp"
  throw new Error("Image content must be PNG, JPEG, GIF or WebP")
}

/** Per-run bounded URL cache; never shares signed URLs or images across accounts. */
export class ClaudeTuiImages {
  private readonly cache = new Map<string, Buffer>()
  private cachedBytes = 0
  private count = 0
  private fileBytes = 0
  private fileCount = 0
  private readonly dir: string
  constructor(tmpDir: string) {
    this.dir = path.join(tmpDir, "images")
  }

  async write(
    source: AnthropicImageSource,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    let bytes: Buffer
    if (source.type === "base64") {
      if (
        source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)
      )
        throw new Error("Invalid or oversized base64 image")
      bytes = Buffer.from(source.data, "base64")
    } else {
      const cached = this.cache.get(source.url)
      bytes = cached ?? (await downloadImage(source.url, signal))
      claudeImageExtension(bytes)
      if (!cached) {
        while (
          this.cache.size >= 32
          || this.cachedBytes + bytes.length > MAX_CACHE_BYTES
        ) {
          const key = this.cache.keys().next().value!
          this.cachedBytes -= this.cache.get(key)!.length
          this.cache.delete(key)
        }
        this.cache.set(source.url, bytes)
        this.cachedBytes += bytes.length
      }
    }
    const extension = claudeImageExtension(bytes)
    if (this.fileCount >= 20 || this.fileBytes + bytes.length > MAX_CACHE_BYTES)
      throw new Error("Interactive message images exceed 20 files or 20 MB")
    signal.throwIfAborted()
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, `image-${++this.count}.${extension}`)
    await fs.writeFile(file, bytes, { mode: 0o600 })
    this.fileCount++
    this.fileBytes += bytes.length
    return file
  }

  async clearFiles(): Promise<void> {
    await fs.rm(this.dir, { force: true, recursive: true })
    this.fileCount = 0
    this.fileBytes = 0
  }
}
