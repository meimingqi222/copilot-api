import { createHash, randomUUID } from "node:crypto"

import type { ClawWs } from "~/services/mimo/ws-proxy"

import { logger } from "~/lib/logger"
import { sleep } from "~/lib/utils"
import { markAccountFailed } from "~/services/mimo/manager"
import {
  connectWebSocketDirect,
  connectWebSocketThroughProxy,
  fetchWithProxy,
} from "~/services/mimo/ws-proxy"

export interface WsMessage {
  type: string
  event?: string
  id?: string
  ok?: boolean
  payload?: Record<string, unknown>
}

export interface AgentPayload {
  runId?: string
  stream?: string
  data?: {
    phase?: string
    text?: string
    startedAt?: number
  }
  sessionKey?: string
  seq?: number
}

export interface ChatEvent {
  event?: string
  payload?: {
    message?: {
      role?: string
      content?: Array<{ type?: string; text?: string }>
    }
    state?: string
  } & AgentPayload
}

export interface StatusResponse {
  data?: {
    status?: string
    expireTime?: number | string
  }
}

export interface TicketResponse {
  data?: {
    ticket?: string
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

const BASE_URL = "https://aistudio.xiaomimimo.com"
const WS_URL = "wss://aistudio.xiaomimimo.com"
const COMMON_HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/json",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/`,
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
} as const

export class NativeClawClient {
  private accountId: string
  private ph: string
  private userId: string
  private serviceToken: string
  label: string
  private proxy: string | undefined
  private ws: ClawWs | null = null
  private connected = false
  private events: Array<ChatEvent> = []
  private responses = new Map<string, WsMessage>()
  private resolveConnected: (() => void) | null = null

  // eslint-disable-next-line max-params
  constructor(
    accountId: string,
    ph: string,
    userId: string,
    serviceToken: string,
    label: string,
    proxy?: string,
  ) {
    this.accountId = accountId
    this.ph = ph
    this.userId = userId
    this.serviceToken = serviceToken
    this.label = label
    this.proxy = proxy
  }

  private get cookies(): string {
    return `serviceToken="${this.serviceToken}"; userId="${this.userId}"; xiaomichatbot_ph="${this.ph}"`
  }

  private get phParam(): string {
    return `xiaomichatbot_ph=${encodeURIComponent(this.ph)}`
  }

  private checkAuth(resp: { status: number }): void {
    if (resp.status === 401) {
      markAccountFailed(this.accountId, "Xiaomi credentials expired (401)")
    }
  }

  private apiHeaders(): Record<string, string> {
    return { Cookie: this.cookies, ...COMMON_HEADERS }
  }

  async destroyClaw(): Promise<boolean> {
    const url = `${BASE_URL}/open-apis/user/mimo-claw/destroy?${this.phParam}`
    try {
      const resp = await fetchWithProxy(
        url,
        { method: "POST", headers: this.apiHeaders() },
        this.proxy,
      )
      const text = await resp.text()
      logger.info(
        `[Claw ${this.label}] Destroy response: ${resp.status} ${text.slice(0, 100)}`,
      )
      this.checkAuth(resp)
      return resp.ok
    } catch (e) {
      logger.error(`[Claw ${this.label}] Destroy claw error:`, e)
      return false
    }
  }

  async createAndWait(): Promise<boolean> {
    const headers = this.apiHeaders()
    const urlAgree = `${BASE_URL}/open-apis/agreement/user/mimo-claw?${this.phParam}`
    const urlCreate = `${BASE_URL}/open-apis/user/mimo-claw/create?${this.phParam}`
    const urlStatus = `${BASE_URL}/open-apis/user/mimo-claw/status`

    try {
      await fetchWithProxy(
        urlAgree,
        { method: "POST", headers },
        this.proxy,
      ).catch(() => {
        // Ignore agreement errors
      })

      const createResp = await fetchWithProxy(
        urlCreate,
        { method: "POST", headers },
        this.proxy,
      )
      const createText = await createResp.text()
      logger.info(
        `[Claw ${this.label}] Create response: ${createResp.status} ${createText.slice(0, 100)}`,
      )
      this.checkAuth(createResp)
      if (!createResp.ok) return false

      const deadline = Date.now() + 120_000
      let lastStatus = ""
      while (Date.now() < deadline) {
        const statusResp = await fetchWithProxy(
          urlStatus,
          { method: "GET", headers },
          this.proxy,
        )
        this.checkAuth(statusResp)
        if (!statusResp.ok) {
          await sleep(2000)
          continue
        }

        const data = (await statusResp.json()) as StatusResponse
        const status = data.data?.status || ""
        if (status !== lastStatus) {
          logger.info(`[Claw ${this.label}] Status: ${status}`)
          lastStatus = status
        }
        if (status === "AVAILABLE") return true
        if (
          status.endsWith("FAILED")
          || status === "DESTROYED"
          || status === "ERROR"
        ) {
          return false
        }
        await sleep(2000)
      }
    } catch (e) {
      logger.error(`[Claw ${this.label}] Create claw error:`, e)
    }
    return false
  }

  async getTicket(): Promise<string> {
    const url = `${BASE_URL}/open-apis/user/ws/ticket?${this.phParam}`
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await withTimeout(
          fetchWithProxy(
            url,
            {
              headers: {
                Cookie: this.cookies,
                Accept: "*/*",
                "User-Agent": "Mozilla/5.0",
                Origin: BASE_URL,
                Referer: `${BASE_URL}/`,
              },
            },
            this.proxy,
          ),
          10_000,
          "getTicket",
        )
        this.checkAuth(resp)
        const data = (await resp.json()) as TicketResponse
        const ticket = data.data?.ticket
        if (ticket) return ticket
      } catch (e) {
        logger.warn(
          `[Claw ${this.label}] Ticket fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      await sleep(3000)
    }
    throw new Error("Failed to get ticket")
  }

  async uploadToFDS(filename: string, content: string): Promise<string | null> {
    const md5hex = createHash("md5").update(content).digest("hex")
    const body = JSON.stringify({ fileName: filename, fileContentMd5: md5hex })
    const genURL = `${BASE_URL}/open-apis/resource/genUploadInfo?${this.phParam}`

    try {
      const genResp = await fetchWithProxy(
        genURL,
        {
          method: "POST",
          headers: {
            Cookie: this.cookies,
            "Content-Type": "application/json",
            Origin: BASE_URL,
            Referer: `${BASE_URL}/`,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          body,
        },
        undefined, // force DNS override via MIMO_API_HOST, bypass proxy
      )
      if (!genResp.ok) return null
      const genData = (await genResp.json()) as {
        code?: number
        data?: { resourceUrl?: string; uploadUrl?: string }
      }
      if (genData.code !== 0 || !genData.data?.uploadUrl) return null

      const putResp = await fetchWithProxy(
        genData.data.uploadUrl,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-MD5": md5hex,
            Origin: BASE_URL,
            Referer: `${BASE_URL}/`,
          },
          body: content,
        },
        undefined,
      )
      if (!putResp.ok) return null

      return genData.data.resourceUrl || null
    } catch {
      return null
    }
  }

  async connect(waitAvailable = true): Promise<boolean> {
    if (waitAvailable) {
      logger.info(
        `[Claw ${this.label}] Creating instance and waiting for availability...`,
      )
      if (!(await this.createAndWait())) return false
    }

    try {
      const ticket = await this.getTicket()
      const wsUrl = `${WS_URL}/ws/proxy?ticket=${ticket}`
      const headers = {
        Cookie: this.cookies,
        Origin: BASE_URL,
      }

      this.ws =
        this.proxy ?
          await connectWebSocketThroughProxy(wsUrl, headers, this.proxy)
        : await connectWebSocketDirect(wsUrl, headers)

      this.ws.addEventListener("message", (rawData: unknown) => {
        this.handleRawWsMessage(rawData)
      })

      this.ws.addEventListener("error", (err: unknown) => {
        logger.error(`[Claw ${this.label}] WS error:`, err)
        this.connected = false
        this.resolveConnected?.()
        this.resolveConnected = null
        this.ws = null
      })

      this.ws.addEventListener("close", (e: unknown) => {
        const ce = e as CloseEvent
        logger.info(
          `[Claw ${this.label}] WS closed code=${ce.code} reason=${ce.reason}`,
        )
        this.connected = false
        this.resolveConnected?.()
        this.resolveConnected = null
        this.ws = null
      })

      if (!this.connected) {
        const success = await new Promise<boolean>((resolve) => {
          if (this.connected) {
            resolve(true)
            return
          }
          this.resolveConnected = () => resolve(true)
          setTimeout(() => {
            this.resolveConnected = null
            resolve(false)
          }, 15000)
        })
        return success
      }
      return this.connected
    } catch (e) {
      logger.error(`[Claw ${this.label}] WS connection error:`, e)
      return false
    }
  }

  sendTestPing(): void {
    if (!this.ws) return
    const testId = randomUUID()
    const payload = {
      type: "req",
      id: testId,
      method: "status",
      params: {},
    }
    this.ws.send(JSON.stringify(payload))
  }

  private handleRawWsMessage(rawData: unknown): void {
    try {
      const raw = parseWsRawData(rawData)
      const data = JSON.parse(raw) as WsMessage
      this.handleWsMessage(data)
    } catch (e) {
      logger.error("WS parse error:", e)
    }
  }

  private handleWsMessage(data: WsMessage): void {
    switch (data.type) {
      case "event": {
        if (data.event === "connect.challenge") {
          this.handleConnectChallenge()
          return
        }
        this.events.push(data as ChatEvent)
        if (this.events.length > 200) {
          this.events = this.events.slice(-100)
        }
        return
      }
      case "res": {
        if (data.id) this.responses.set(data.id, data)
        if (data.ok && data.payload?.type === "hello-ok") {
          this.connected = true
          if (this.resolveConnected) {
            this.resolveConnected()
            this.resolveConnected = null
          }
        }
        return
      }
      default: {
        return
      }
    }
  }

  private handleConnectChallenge(): void {
    const resp = {
      type: "req",
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          version: "mimo-claw-ui",
          platform: "Win32",
          mode: "cli",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        caps: ["tool-events"],
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        locale: "zh-CN",
      },
    }
    this.ws?.send(JSON.stringify(resp))
  }

  async sendMessage(text: string, timeout = 120): Promise<string> {
    if (!this.ws) {
      return "(Send failed: WS not connected)"
    }
    this.events = []
    const reqId = randomUUID()
    const payload = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: text,
        idempotencyKey: randomUUID(),
      },
    }
    this.ws.send(JSON.stringify(payload))

    for (let i = 0; i < timeout * 10; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.ws || !this.connected) break
      const reply = this.extractReplyFromEvents()
      if (reply !== null) {
        this.events = []
        return reply
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    this.events = []
    if (!this.connected) return "(Send failed: WS disconnected)"
    return "(Wait for final reply timeout)"
  }

  private extractReplyFromEvents(): string | null {
    for (const evt of this.events) {
      if (evt.event === "chat") {
        const msg = evt.payload?.message || {}
        if (msg.role !== "assistant") continue
        const content = msg.content || []
        let reply = ""
        for (const c of content) {
          if (c.type === "text" && c.text) {
            reply = c.text
          }
        }
        if (evt.payload?.state === "final" && reply) {
          return reply
        }
      } else if (evt.event === "agent") {
        const p = evt.payload
        logger.debug(
          `[Claw ${this.label}] agent event: stream=${p?.stream} phase=${p?.data?.phase} text=${(p?.data?.text || "").slice(0, 60)}`,
        )
        if (
          p?.stream === "messages"
          && p.data?.phase === "end"
          && p.data.text
        ) {
          return p.data.text
        }
      }
    }
    return null
  }

  close() {
    this.connected = false
    this.resolveConnected = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore close errors
      }
      this.ws = null
    }
  }
}

function parseWsRawData(rawData: unknown): string {
  let raw: unknown = rawData
  if (
    typeof rawData !== "string"
    && rawData
    && typeof rawData === "object"
    && "data" in rawData
  ) {
    raw = (rawData as { data: unknown }).data
  }
  return typeof raw === "string" ? raw : String(raw)
}
