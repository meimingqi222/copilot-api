import type { TLSSocket } from "node:tls"

import { HttpsProxyAgent } from "https-proxy-agent"
import crypto from "node:crypto"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"

export interface ClawWs {
  send(data: string): void
  addEventListener(
    event: string,
    handler: (...args: Array<unknown>) => void,
  ): void
  close(): void
}

const proxyAgents = new Map<string, HttpsProxyAgent<string>>()

const CHINA_IP_RANGES = ["39.", "111.", "124.", "202.69.", "220.181."]

let cachedChinaIps: Array<string> = []
let lastResolveTime = 0
const RESOLVE_INTERVAL_MS = 5 * 60 * 1000

async function resolveChinaIps(): Promise<Array<string>> {
  const now = Date.now()
  if (
    cachedChinaIps.length > 0
    && now - lastResolveTime < RESOLVE_INTERVAL_MS
  ) {
    return cachedChinaIps
  }
  try {
    const url = `https://site.ip138.com/domain/read.do?domain=aistudio.xiaomimimo.com&time=${now}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    })
    clearTimeout(timer)
    const data = (await resp.json()) as {
      status: boolean
      data?: Array<{ ip: string }>
    }
    if (!data.status || !data.data) return cachedChinaIps
    const chinaIps = data.data
      .map((item) => item.ip)
      .filter((ip) => CHINA_IP_RANGES.some((prefix) => ip.startsWith(prefix)))
    if (chinaIps.length > 0) {
      cachedChinaIps = chinaIps
      lastResolveTime = now
    }
    return cachedChinaIps
  } catch {
    return cachedChinaIps
  }
}

async function getMimoApiHost(): Promise<string> {
  const envHost = process.env.MIMO_API_HOST
  if (envHost) return envHost
  const ips = await resolveChinaIps()
  if (ips.length > 0) {
    return ips[Math.floor(Math.random() * ips.length)]
  }
  return "aistudio.xiaomimimo.com"
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")
}

export function encodeWsFrame(data: Buffer): Buffer {
  const length = data.length
  const maskKey = crypto.randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    masked[i] = data[i] ^ maskKey[i % 4]
  }
  let headerLen = 2
  if (length >= 65536) {
    headerLen = 10
  } else if (length >= 126) {
    headerLen = 4
  }
  const header = Buffer.alloc(headerLen)
  header[0] = 0x81
  if (length < 126) {
    header[1] = 0x80 | length
    return Buffer.concat([header, maskKey, masked])
  }
  if (length < 65536) {
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, maskKey, masked])
  }
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, maskKey, masked])
}

interface WsFrame {
  opcode: number
  payload: Buffer
  remaining: Buffer
}

export function decodeWsFrame(data: Buffer): WsFrame {
  const firstByte = data[0]
  const opcode = firstByte & 0x0f
  const secondByte = data[1]
  let length = secondByte & 0x7f
  let offset = 2
  if (length === 126) {
    length = data.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    length = Number(data.readBigUInt64BE(offset))
    offset += 8
  }
  const masked = (secondByte & 0x80) !== 0
  if (masked) {
    const maskKey = data.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.alloc(length)
    for (let i = 0; i < length; i++) {
      payload[i] = data[offset + i] ^ maskKey[i % 4]
    }
    return { opcode, payload, remaining: data.subarray(offset + length) }
  }
  const payload = data.subarray(offset, offset + length)
  return { opcode, payload, remaining: data.subarray(offset + length) }
}

function performWsUpgrade(
  tlsSock: TLSSocket,
  urlObj: URL,
  headers: Record<string, string>,
  cleanup?: () => void,
): Promise<ClawWs> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const listeners: Record<
      string,
      Array<(...args: Array<unknown>) => void>
    > = {
      message: [],
      error: [],
      close: [],
    }

    const key = crypto.randomBytes(16).toString("base64")
    const wsHost = headers.Host || urlObj.hostname
    const headerLines = [
      `GET ${urlObj.pathname}${urlObj.search} HTTP/1.1`,
      `Host: ${wsHost}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ]
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "host") continue
      headerLines.push(`${k}: ${v}`)
    }
    headerLines.push("", "")
    tlsSock.write(headerLines.join("\r\n"))

    tlsSock.on("data", function handler(data: Buffer) {
      buf = Buffer.concat([buf, data])
      const headerEnd = buf.indexOf("\r\n\r\n")
      if (headerEnd === -1) return

      const headerStr = buf.subarray(0, headerEnd).toString()
      if (!headerStr.includes("101")) {
        const body = buf.subarray(headerEnd + 4).toString()
        reject(
          new Error(
            `WS upgrade failed: ${headerStr.slice(0, 100)} ${body.slice(0, 100)}`,
          ),
        )
        return
      }

      // WS upgrade successful
      let frameBuf = buf.subarray(headerEnd + 4)
      buf = Buffer.alloc(0)

      const messageBuffer: Array<string> = []

      const wsHandle: ClawWs = {
        send(data: string) {
          if (!tlsSock.destroyed) {
            tlsSock.write(encodeWsFrame(Buffer.from(data, "utf8")))
          }
        },
        addEventListener(
          event: string,
          handler: (...args: Array<unknown>) => void,
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (listeners[event]) {
            listeners[event].push(handler)
          }
          if (event === "message" && messageBuffer.length > 0) {
            const msgs = [...messageBuffer]
            messageBuffer.length = 0
            for (const msg of msgs) {
              for (const h of listeners.message) {
                h(msg)
              }
            }
          }
        },
        close() {
          try {
            tlsSock.end()
          } catch {
            // ignore
          }
          cleanup?.()
        },
      }

      function processWsFrames() {
        const textFrames: Array<string> = []
        let closePending = false
        let closeCode = 1000
        let closeReason = "Remote close"

        while (frameBuf.length >= 2) {
          try {
            const frame = decodeWsFrame(frameBuf)
            frameBuf = Buffer.from(frame.remaining)

            switch (frame.opcode) {
              case 0x01: {
                textFrames.push(frame.payload.toString())

                break
              }
              case 0x08: {
                if (frame.payload.length >= 2) {
                  closeCode = frame.payload.readUInt16BE(0)
                  closeReason =
                    frame.payload.length > 2 ?
                      frame.payload.subarray(2).toString()
                    : "Remote close"
                }
                closePending = true

                break
              }
              case 0x09: {
                tlsSock.write(Buffer.from([0x8a, 0x00]))

                break
              }
              // No default
            }
          } catch {
            break
          }
        }

        for (const text of textFrames) {
          if (listeners.message.length > 0) {
            for (const h of listeners.message) {
              h(text)
            }
          } else {
            messageBuffer.push(text)
          }
        }

        if (closePending) {
          for (const h of listeners.close) {
            h(closeCode, closeReason)
          }
        }
      }

      // Start reading WS frames (remove upgrade-response listener first)
      tlsSock.removeAllListeners("data")
      tlsSock.on("data", (chunk: Buffer) => {
        frameBuf = Buffer.concat([frameBuf, chunk])
        processWsFrames()
      })

      // Process any frames that arrived in the same packet as the upgrade response
      processWsFrames()

      resolve(wsHandle)
    })
  })
}

export async function connectWebSocketDirect(
  wsUrl: string,
  headers: Record<string, string>,
): Promise<ClawWs> {
  const urlObj = new URL(wsUrl)
  if (
    urlObj.hostname === "aistudio.xiaomimimo.com"
    || urlObj.hostname.endsWith(".aistudio.xiaomimimo.com")
  ) {
    const resolvedHost = await getMimoApiHost()
    if (isIpAddress(resolvedHost)) {
      urlObj.hostname = resolvedHost
      const wsHeaders = { ...headers, Host: "aistudio.xiaomimimo.com" }
      return connectWsViaNodeTls(urlObj, wsHeaders)
    }
    urlObj.hostname = resolvedHost
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(urlObj.toString(), { headers })

    const timeout = setTimeout(() => {
      reject(new Error("WebSocket connection timeout"))
    }, 15000)

    ws.addEventListener("open", () => {
      clearTimeout(timeout)
      resolve(ws as unknown as ClawWs)
    })

    ws.addEventListener("error", (e: Event) => {
      clearTimeout(timeout)
      reject(
        new Error(
          "WebSocket connection failed: "
            + ((e as unknown as { message?: string }).message || "unknown"),
        ),
      )
    })
  })
}

function connectWsViaNodeTls(
  urlObj: URL,
  headers: Record<string, string>,
): Promise<ClawWs> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      {
        host: urlObj.hostname,
        port: Number(urlObj.port) || 443,
        servername: "aistudio.xiaomimimo.com",
        rejectUnauthorized: false,
      },
      () => {
        performWsUpgrade(sock, urlObj, headers).then(resolve).catch(reject)
      },
    )
    sock.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    setTimeout(() => {
      sock.destroy()
      reject(new Error("WebSocket TLS connection timeout"))
    }, 15000)
  })
}

export async function connectWebSocketThroughProxy(
  wsUrl: string,
  headers: Record<string, string>,
  proxyUrl: string,
): Promise<ClawWs> {
  const resolvedHost = await getMimoApiHost()
  return new Promise((resolve, reject) => {
    const urlObj = new URL(wsUrl)
    const proxyUrlObj = new URL(proxyUrl)

    const sock = net.connect(
      Number(proxyUrlObj.port || 3128),
      proxyUrlObj.hostname,
      () => {
        sock.write(
          `CONNECT ${resolvedHost}:443 HTTP/1.1\r\nHost: ${urlObj.hostname}:443\r\n\r\n`,
        )
      },
    )

    sock.on("data", (data) => {
      const msg = data.toString()
      if (msg.includes("200")) {
        const tlsSock = tls.connect({
          socket: sock,
          host: resolvedHost,
          servername: urlObj.hostname,
        })

        tlsSock.on("secureConnect", () => {
          performWsUpgrade(tlsSock, urlObj, headers, () => sock.destroy())
            .then(resolve)
            .catch(reject)
        })

        tlsSock.on("error", (err) => {
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      }
    })

    sock.on("error", reject)

    setTimeout(() => {
      reject(new Error("WebSocket connection timeout"))
    }, 15000)
  })
}

export async function fetchWithProxy(
  url: string,
  options?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  if (!proxyUrl) {
    const u = new URL(url)
    if (
      u.hostname === "aistudio.xiaomimimo.com"
      || u.hostname.endsWith(".aistudio.xiaomimimo.com")
    ) {
      const originalHost = u.hostname
      const resolvedHost = await getMimoApiHost()
      u.hostname = resolvedHost
      const headers = {
        ...(options?.headers as Record<string, string> | undefined),
        Host: originalHost,
      }
      if (isIpAddress(resolvedHost)) {
        return fetchViaNodeHttps({
          ip: resolvedHost,
          urlObj: u,
          serverName: originalHost,
          method: options?.method || "GET",
          headers,
          body: options?.body,
        })
      }
      return fetch(u.toString(), { ...options, headers })
    }
    return fetch(url, options)
  }
  let agent = proxyAgents.get(proxyUrl)
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl)
    proxyAgents.set(proxyUrl, agent)
  }
  const urlObj = new URL(url)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: options?.method || "GET",
        headers: options?.headers as Record<string, string>,
        agent,
      },
      (res) => {
        let body = ""
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on("end", () => {
          resolve(
            new Response(body, {
              status: res.statusCode,
              statusText: res.statusMessage,
            }),
          )
        })
      },
    )
    req.on("error", reject)
    if (options?.body && typeof options.body === "string") {
      req.write(options.body)
    }
    req.end()
  })
}

function fetchViaNodeHttps(opts: {
  ip: string
  urlObj: URL
  serverName: string
  method: string
  headers: Record<string, string>
  body?: unknown
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let resolved = false
    const req = https.request(
      {
        hostname: opts.ip,
        port: opts.urlObj.port || 443,
        path: opts.urlObj.pathname + opts.urlObj.search,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: false,
        servername: opts.serverName,
        timeout: 15_000,
      },
      (res) => {
        let responseBody = ""
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on("end", () => {
          if (resolved) return
          resolved = true
          resolve(
            new Response(responseBody, {
              status: res.statusCode,
              statusText: res.statusMessage,
            }),
          )
        })
      },
    )
    req.on("error", (err) => {
      if (resolved) return
      resolved = true
      reject(err)
    })
    req.on("timeout", () => {
      if (resolved) return
      resolved = true
      req.destroy(new Error("Request timeout"))
    })
    if (opts.body && typeof opts.body === "string") {
      req.write(opts.body)
    }
    req.end()
  })
}
