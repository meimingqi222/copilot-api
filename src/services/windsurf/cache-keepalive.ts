import { createHash, randomUUID } from "node:crypto"

import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import { logStore } from "~/lib/log-store"
import { logger } from "~/lib/logger"
import { getProviderConnection } from "~/lib/provider-connections"
import { recordAccountUsage } from "~/lib/usage"
import { connectionFetchInit } from "~/services/protocols/shared"
import {
  ProtobufEncoder,
  decompressConnectPayload,
  encodeConnectRequest,
} from "~/services/windsurf/protobuf"
import { resolveWindsurfCacheKeepaliveSettings } from "~/services/windsurf/settings"

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_JOBS = 32

/** Raw field spans, not a decode/re-encode: unknown fields and cache marks survive. */
function fields(
  bytes: Uint8Array,
): Array<{ field: number; wire: number; raw: Uint8Array; value: Uint8Array }> {
  let offset = 0
  const varint = () => {
    let value = 0
    for (let shift = 0; shift <= 49 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
    }
    throw new Error("Invalid keepalive protobuf varint")
  }
  const result = []
  while (offset < bytes.length) {
    if (result.length >= 100_000)
      throw new Error("Too many keepalive protobuf fields")
    const start = offset
    const tag = varint()
    const wire = tag % 8
    let valueStart = offset
    if (wire === 0) varint()
    else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else if (wire === 2) {
      const length = varint()
      valueStart = offset
      offset += length
    } else throw new Error("Unsupported keepalive protobuf wire type")
    if (offset > bytes.length || tag < 8)
      throw new Error("Truncated keepalive protobuf")
    result.push({
      field: Math.floor(tag / 8),
      wire,
      raw: bytes.subarray(start, offset),
      value: bytes.subarray(valueStart, offset),
    })
  }
  return result
}

/** Copy history/session/cache boundaries exactly; only f8.2 and a new f3 change. */
export async function buildWindsurfKeepaliveBody(
  body: Uint8Array,
): Promise<Uint8Array> {
  if (body.length < 5 || body.length > MAX_BODY_BYTES)
    throw new Error("Keepalive request too large or empty")
  const length = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(1)
  if (length !== body.length - 5 || body[0]! > 1)
    throw new Error("Invalid keepalive Connect envelope")
  const proto =
    body[0] === 1 ?
      decompressConnectPayload(body.subarray(5))
    : body.subarray(5)
  if (proto.length > MAX_BODY_BYTES)
    throw new Error("Keepalive expanded request too large")
  const parts: Uint8Array[] = []
  let configuration = false
  for (const field of fields(proto)) {
    if (field.field !== 8) {
      parts.push(field.raw)
      continue
    }
    if (field.wire !== 2) throw new Error("Invalid keepalive configuration")
    const cfg = fields(field.value)
      .filter((f) => f.field !== 2)
      .map((f) => f.raw)
    const max = new ProtobufEncoder()
    max.writeVarint(2, 1)
    cfg.push(max.toUint8Array())
    const replacement = new ProtobufEncoder()
    replacement.writeBytes(8, Buffer.concat(cfg))
    parts.push(replacement.toUint8Array())
    configuration = true
  }
  if (!configuration) throw new Error("Missing keepalive configuration")
  const continuation = new ProtobufEncoder()
  continuation.writeNested(3, (prompt) => {
    prompt.writeString(1, randomUUID())
    prompt.writeVarint(2, 1)
    prompt.writeString(3, "continue")
  })
  parts.push(continuation.toUint8Array())
  return encodeConnectRequest(Buffer.concat(parts))
}

export function windsurfKeepaliveKey(options: {
  connectionId: string
  conversationKey: string
  model: string
  payload: ChatCompletionsPayload
  agent?: string
  instructionsAndTools?: unknown
}): string {
  const prefix = options.instructionsAndTools ?? [
    options.payload.messages.filter(
      (m) => m.role === "system" || m.role === "developer",
    ),
    options.payload.tools ?? [],
  ]
  return createHash("sha256")
    .update(
      JSON.stringify(
        [
          options.connectionId,
          options.conversationKey,
          options.model,
          options.agent ?? "",
          prefix,
        ],
        // Claude Code changes its billing fingerprint every turn. It is not
        // part of the instruction prefix and must not strand the old paid job.
        (key, value: unknown) =>
          key === "cache_control" ? undefined
          : typeof value === "string" ?
            value.replace(/^x-anthropic-billing-header:[^\r\n]*(?:\r?\n|$)/, "")
          : value,
      ),
    )
    .digest("hex")
}

interface PingUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

function readPingEvent(event: CopilotStreamEvent):
  | {
      usage?: PingUsage
      filtered: boolean
    }
  | undefined {
  if (!event.data || event.data === "[DONE]") return undefined
  try {
    const value = JSON.parse(event.data) as {
      usage?: PingUsage
      choices?: Array<{ finish_reason?: string | null }>
    }
    const usage = value.usage
    return {
      filtered:
        value.choices?.some(
          (choice) => choice.finish_reason === "content_filter",
        ) ?? false,
      usage:
        (
          usage
          && Number.isFinite(usage.prompt_tokens)
          && Number.isFinite(usage.completion_tokens)
        ) ?
          usage
        : undefined,
    }
  } catch {
    return undefined
  }
}

export interface KeepaliveRequest {
  connectionId: string
  apiKey: string
  userJwt: string
  url: string
  headers: Record<string, string>
  body: Uint8Array
  model: string
  sentAt: number
  signal?: AbortSignal
  streamFactory: (response: Response) => AsyncIterable<CopilotStreamEvent>
}

interface Timers {
  now: () => number
  set: (fn: () => void, ms: number) => { unref?: () => void }
  clear: (timer: { unref?: () => void }) => void
}
interface Job {
  timer?: ReturnType<Timers["set"]>
  controller?: AbortController
  count: number
  misses: number
}

interface Dependencies {
  timers: Timers
  fetch: (url: string, init: RequestInit) => Promise<Response>
  connection: (id: string) => ProviderConnection | undefined
}

/** Injectable clock/transport make the paid background path testable without credentials. */
export class WindsurfCacheKeepalive {
  private jobs = new Map<string, Job>()
  private readonly deps: Dependencies
  constructor(
    deps: Dependencies = {
      timers: {
        now: Date.now,
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
      fetch: (url, init) => fetch(url, init),
      connection: getProviderConnection,
    },
  ) {
    this.deps = deps
  }

  begin(key: string): Job {
    this.stop(key)
    while (this.jobs.size >= MAX_JOBS) this.stop(this.jobs.keys().next().value!)
    const job = { count: 0, misses: 0 }
    this.jobs.set(key, job)
    return job
  }

  stop(key: string, expected?: Job): void {
    const job = this.jobs.get(key)
    if (!job || (expected && job !== expected)) return
    this.jobs.delete(key)
    if (job.timer) this.deps.timers.clear(job.timer)
    job.controller?.abort()
  }

  stopAll(): void {
    for (const key of this.jobs.keys()) this.stop(key)
  }

  private current(request: KeepaliveRequest): ProviderConnection | undefined {
    const connection = this.deps.connection(request.connectionId)
    if (
      !connection?.enabled
      || !resolveWindsurfCacheKeepaliveSettings(connection).enabled
    )
      return undefined
    const credential = connection.credentials.find(
      (c) => c.enabled && c.value === request.apiKey,
    )
    if (
      !credential
      || credential.status !== "ready"
      || credential.exhaustedAt
      || (credential.cooldownUntil ?? 0) > this.deps.timers.now()
    )
      return undefined
    // Never replay an expired JWT. Opaque enterprise credentials remain supported.
    try {
      const data = JSON.parse(
        Buffer.from(
          request.userJwt.split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ) as { exp?: number }
      if (
        typeof data.exp === "number"
        && data.exp * 1000 <= this.deps.timers.now() + 30_000
      )
        return undefined
    } catch {
      /* Enterprise servers can issue opaque user JWTs. */
    }
    return connection
  }

  async *wrap(
    source: AsyncIterable<CopilotStreamEvent>,
    key: string,
    job: Job,
    request: KeepaliveRequest,
  ): AsyncIterable<CopilotStreamEvent> {
    let usage: PingUsage | undefined
    let complete = false
    let filtered = false
    try {
      for await (const event of source) {
        const parsed = readPingEvent(event)
        usage = parsed?.usage ?? usage
        filtered ||= parsed?.filtered ?? false
        if (event.data === "[DONE]") complete = true
        yield event
      }
    } catch (error) {
      complete = false
      throw error
    } finally {
      if (
        complete
        && !filtered
        && !request.signal?.aborted
        && usage
        && ((usage.prompt_tokens_details?.cached_tokens ?? 0) > 0
          || (usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0)
            > 0)
      ) {
        await this.schedule(key, job, request)
      } else this.stop(key, job)
    }
  }

  private async schedule(
    key: string,
    job: Job,
    request: KeepaliveRequest,
  ): Promise<void> {
    if (this.jobs.get(key) !== job) return
    if (request.signal?.aborted || !this.current(request)) {
      this.stop(key, job)
      return
    }
    try {
      const body = await buildWindsurfKeepaliveBody(request.body)
      if (this.jobs.get(key) !== job) return
      if (request.signal?.aborted) {
        this.stop(key, job)
        return
      }
      const ping = { ...request, body, signal: undefined }
      this.next(key, job, ping, request.sentAt)
    } catch (error) {
      logger.warn("[windsurf] cache keepalive not scheduled", error)
      this.stop(key, job)
    }
  }

  private next(
    key: string,
    job: Job,
    request: KeepaliveRequest,
    from: number,
  ): void {
    const connection = this.current(request)
    if (!connection) {
      this.stop(key, job)
      return
    }
    const settings = resolveWindsurfCacheKeepaliveSettings(connection)
    if (job.count >= settings.maxPings) {
      this.stop(key, job)
      return
    }
    job.timer = this.deps.timers.set(
      () => {
        void this.run(key, job, request)
      },
      Math.max(0, from + settings.intervalMs - this.deps.timers.now()),
    )
    job.timer.unref?.()
  }

  private async run(
    key: string,
    job: Job,
    request: KeepaliveRequest,
  ): Promise<void> {
    job.timer = undefined
    if (this.jobs.get(key) !== job) return
    const connection = this.current(request)
    if (
      !connection
      || job.count >= resolveWindsurfCacheKeepaliveSettings(connection).maxPings
    ) {
      this.stop(key, job)
      return
    }
    const controller = new AbortController()
    job.controller = controller
    job.count++
    const at = this.deps.timers.now()
    const deadline = this.deps.timers.set(() => controller.abort(), 60_000)
    deadline.unref?.()
    let status = 0
    let usage: PingUsage | undefined
    let filtered = false
    let errorText: string | undefined
    try {
      const headers = { ...request.headers }
      delete headers["Connect-Content-Encoding"]
      if (request.body[0] === 1) headers["Connect-Content-Encoding"] = "gzip"
      const response = await this.deps.fetch(
        request.url,
        connectionFetchInit(connection, {
          method: "POST",
          headers,
          body: request.body,
          signal: controller.signal,
        }),
      )
      status = response.status
      if (response.ok) {
        for await (const event of request.streamFactory(response)) {
          const parsed = readPingEvent(event)
          usage = parsed?.usage ?? usage
          filtered ||= parsed?.filtered ?? false
        }
      } else await response.body?.cancel()
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error)
      // Stream errors can carry 200/Connect failures: never retry a refused ping.
      status = 0
    } finally {
      this.deps.timers.clear(deadline)
      job.controller = undefined
      this.report(request, connection, {
        status,
        usage,
        errorText,
        latencyMs: this.deps.timers.now() - at,
      })
    }
    if (this.jobs.get(key) !== job) return
    const read = usage?.prompt_tokens_details?.cached_tokens ?? 0
    job.misses =
      status === 200 && usage && read > 0 && read * 2 >= usage.prompt_tokens ?
        0
      : job.misses + 1
    if (status !== 200 || filtered || job.misses >= 2) this.stop(key, job)
    else this.next(key, job, request, at)
  }

  private report(
    request: KeepaliveRequest,
    connection: ProviderConnection,
    result: {
      status: number
      usage?: PingUsage
      errorText?: string
      latencyMs: number
    },
  ): void {
    const { usage } = result
    const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWriteTokens =
      usage?.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    const credential = connection.credentials.find(
      (c) => c.value === request.apiKey,
    )
    if (usage && credential)
      recordAccountUsage({
        identity: {
          ownerId: connection.id,
          connectionId: connection.id,
          credentialId: credential.id,
          provider: "windsurf",
        },
        model: request.model,
        rounds: [
          {
            promptTokens: Math.max(
              0,
              usage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
            ),
            completionTokens: usage.completion_tokens,
            cacheReadTokens,
            cacheWriteTokens,
          },
        ],
      })
    logStore.push({
      timestamp: Date.now(),
      requestId: randomUUID(),
      level: result.status === 200 ? "info" : "warn",
      message: "Windsurf cache_keepalive (paid background request)",
      kind: "cache_keepalive",
      provider: "windsurf",
      protocol: connection.protocol,
      connectionId: connection.id,
      connectionName: connection.name,
      accountId: connection.id,
      model: request.model,
      modelUpstream: request.model,
      credentialId: credential?.id,
      statusCode: result.status,
      outcome: result.status === 200 ? "success" : "failed",
      latencyMs: result.latencyMs,
      error: result.errorText,
      ...(usage ?
        {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.prompt_tokens + usage.completion_tokens,
          cacheReadTokens,
          cacheWriteTokens,
        }
      : {}),
    })
  }
}

export const windsurfCacheKeepalive = new WindsurfCacheKeepalive()
process.once("exit", () => windsurfCacheKeepalive.stopAll())
