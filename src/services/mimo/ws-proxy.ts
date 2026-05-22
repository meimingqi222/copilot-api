/* eslint-disable max-depth */
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

export function connectWebSocketThroughProxy(
  wsUrl: string,
  headers: Record<string, string>,
  proxyUrl: string,
): Promise<ClawWs> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(wsUrl)
    const proxyUrlObj = new URL(proxyUrl)

    const sock = net.connect(
      Number(proxyUrlObj.port || 3128),
      proxyUrlObj.hostname,
      () => {
        sock.write(
          `CONNECT ${urlObj.hostname}:443 HTTP/1.1\r\nHost: ${urlObj.hostname}:443\r\n\r\n`,
        )
      },
    )

    let connected = false
    let tlsSock: TLSSocket | null = null
    let buf = Buffer.alloc(0)
    const listeners: Record<
      string,
      Array<(...args: Array<unknown>) => void>
    > = {
      message: [],
      error: [],
      close: [],
    }

    sock.on("data", (data) => {
      if (!connected) {
        const msg = data.toString()
        if (msg.includes("200")) {
          connected = true
          tlsSock = tls.connect({
            socket: sock,
            host: urlObj.hostname,
            servername: urlObj.hostname,
          })

          tlsSock.on("secureConnect", () => {
            const key = crypto.randomBytes(16).toString("base64")
            const headerLines = [
              `GET ${urlObj.pathname}${urlObj.search} HTTP/1.1`,
              `Host: ${urlObj.hostname}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${key}`,
              "Sec-WebSocket-Version: 13",
            ]
            for (const [k, v] of Object.entries(headers)) {
              headerLines.push(`${k}: ${v}`)
            }
            headerLines.push("", "")
            ;(tlsSock as TLSSocket).write(headerLines.join("\r\n"))
          })

          tlsSock.on("data", (wsData) => {
            buf = Buffer.concat([buf, wsData])
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

            // Buffer messages until a listener is registered
            const messageBuffer: Array<string> = []

            const wsHandle: ClawWs = {
              send(data: string) {
                if (tlsSock && !tlsSock.destroyed) {
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
                  tlsSock?.end()
                  sock.destroy()
                } catch {
                  // ignore
                }
              },
            }

            // Start reading WS frames (remove upgrade-response listener first)
            ;(tlsSock as TLSSocket).removeAllListeners("data")
            ;(tlsSock as TLSSocket).on("data", (chunk: Buffer) => {
              frameBuf = Buffer.concat([frameBuf, chunk])
              while (frameBuf.length >= 2) {
                try {
                  const frame = decodeWsFrame(frameBuf)
                  frameBuf = Buffer.from(frame.remaining)
                  switch (frame.opcode) {
                    case 0x01: {
                      const text = frame.payload.toString()
                      if (listeners.message.length > 0) {
                        for (const h of listeners.message) {
                          h(text)
                        }
                      } else {
                        messageBuffer.push(text)
                      }

                      break
                    }
                    case 0x08: {
                      for (const h of listeners.close) {
                        h(1000, "Remote close")
                      }
                      return
                    }
                    case 0x09: {
                      tlsSock?.write(Buffer.from([0x8a, 0x00]))

                      break
                    }
                    // No default
                  }
                } catch {
                  break
                }
              }
            })

            resolve(wsHandle)
          })

          tlsSock.on("error", (err) => {
            reject(err instanceof Error ? err : new Error(String(err)))
          })
        }
      }
    })

    sock.on("error", reject)

    setTimeout(() => {
      reject(new Error("WebSocket connection timeout"))
    }, 15000)
  })
}

export function fetchWithProxy(
  url: string,
  options?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  if (!proxyUrl) {
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
