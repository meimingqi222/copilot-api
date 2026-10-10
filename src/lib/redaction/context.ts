import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, createHash, randomBytes } from "node:crypto"
import type { Context } from "hono"

import { LocalUnavailableError } from "~/lib/error"
import { state } from "~/lib/state"
import { getSystemSettings } from "~/lib/system-config"
import {
  findRedactions,
  type RedactionConfig,
  type RedactionMatch,
} from "~/lib/redaction/rules"
import {
  coveredContent,
  transformContent,
  type SignedContent,
} from "~/lib/redaction/wire"

const TOKEN = /\{\{(SECRET|HOME|WORD)_[a-f0-9]{32}\}\}/g
const KEY = randomBytes(32)
const TTL_MS = 60 * 60_000
const MAX_BYTES = 16 * 1024 * 1024
const MAX_BLOCK_BYTES = 1024 * 1024
const MAX_TENANT_BYTES = 2 * 1024 * 1024
const MAX_TENANT_ITEMS = 1024

export class RedactionError extends LocalUnavailableError {
  constructor(message: string, status = 422) {
    super(message, new Response(null, { status }), message)
  }
}

interface Entry {
  value: string
  json: string
  kind: RedactionMatch["kind"]
}
interface SignedReplay {
  original: Record<string, unknown>
  visibleHash: string
  issuer: string
}
interface Tenant {
  entries: Map<string, Entry>
  signed: Map<string, SignedReplay>
  bytes: number
  touched: number
  leases: number
  tracked: boolean
  cache: Map<string, number>
  active: Set<Set<string>>
  version: number
}
const tenants = new Map<string, Tenant>()
let retainedBytes = 0

function discardTenant(key: string, tenant: Tenant): void {
  tenants.delete(key)
  retainedBytes -= tenant.bytes
  tenant.tracked = false
}

function evictUnused(tenant: Tenant): boolean {
  for (const [key, bytes] of tenant.cache) {
    if ([...tenant.active].some((used) => used.has(key))) continue
    tenant.cache.delete(key)
    tenant.entries.delete(key)
    tenant.signed.delete(key)
    tenant.bytes -= bytes
    if (tenant.tracked) retainedBytes -= bytes
    tenant.version++
    return true
  }
  return false
}

function tenantFor(id?: string): Tenant {
  const now = Date.now()
  for (const [key, tenant] of tenants)
    if (!tenant.leases && now - tenant.touched > TTL_MS)
      discardTenant(key, tenant)
  const existing = id ? tenants.get(id) : undefined
  if (existing) {
    existing.touched = now
    tenants.delete(id!)
    tenants.set(id!, existing)
    return existing
  }
  const tenant: Tenant = {
    entries: new Map(),
    signed: new Map(),
    bytes: 0,
    touched: now,
    leases: 0,
    tracked: Boolean(id),
    cache: new Map(),
    active: new Set(),
    version: 0,
  }
  if (id) {
    if (tenants.size >= 1024) {
      const oldest = [...tenants].find(([, value]) => !value.leases)
      if (!oldest)
        throw new RedactionError("Redaction identity capacity exceeded", 503)
      discardTenant(...oldest)
    }
    tenants.set(id, tenant)
  }
  return tenant
}

function reserve(tenant: Tenant, bytes: number): void {
  if (bytes > MAX_TENANT_BYTES)
    throw new RedactionError("Redaction memory capacity exceeded", 503)
  while (
    tenant.bytes + bytes > MAX_TENANT_BYTES
    || (bytes > 0 && tenant.cache.size >= MAX_TENANT_ITEMS)
  )
    if (!evictUnused(tenant))
      throw new RedactionError("Redaction caller capacity exceeded", 503)
  if (tenant.tracked) {
    for (const [key, other] of tenants) {
      if (retainedBytes + bytes <= MAX_BYTES) break
      if (other !== tenant && !other.leases) discardTenant(key, other)
    }
    if (retainedBytes + bytes > MAX_BYTES)
      throw new RedactionError("Redaction memory capacity exceeded", 503)
    retainedBytes += bytes
  }
  tenant.bytes += bytes
  tenant.touched = Date.now()
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export class RedactionScope {
  private readonly tenant: Tenant
  private readonly allowed = new Map<string, Entry>()
  private readonly identity: string
  private readonly used = new Set<string>()
  private readonly words: Set<string>
  private readonly textCache = Array.from(
    { length: 4 },
    () => new Map<string, { version: number; value: string }>(),
  )
  private cachedBytes = 0
  private leases = 0
  readonly config: RedactionConfig

  constructor(config: RedactionConfig, identity?: string) {
    this.config = Object.freeze(config)
    Object.freeze(this.config.words)
    Object.freeze(this.config.homePrefixes)
    this.words = new Set(config.words)
    this.identity = identity ?? randomBytes(16).toString("hex")
    this.tenant = tenantFor(identity)
  }

  acquire(): () => void {
    if (!this.tenant.tracked) {
      this.tenant.tracked = true
      retainedBytes += this.tenant.bytes
      try {
        reserve(this.tenant, 0)
      } catch (error) {
        retainedBytes -= this.tenant.bytes
        this.tenant.tracked = false
        throw error
      }
    }
    this.leases++
    this.tenant.leases++
    this.tenant.active.add(this.used)
    let released = false
    return () => {
      if (released) return
      released = true
      this.tenant.touched = Date.now()
      if (--this.leases === 0) this.tenant.active.delete(this.used)
      if (
        --this.tenant.leases === 0
        && tenants.get(this.identity) !== this.tenant
      ) {
        retainedBytes -= this.tenant.bytes
        this.tenant.tracked = false
      }
    }
  }

  private touch(key: string): void {
    this.used.add(key)
    const bytes = this.tenant.cache.get(key)
    if (bytes !== undefined) {
      this.tenant.cache.delete(key)
      this.tenant.cache.set(key, bytes)
    }
  }

  private placeholder(match: RedactionMatch): string {
    const suffix = createHmac("sha256", KEY)
      .update(`${this.identity}\0${match.kind}\0${match.value}`)
      .digest("hex")
      .slice(0, 32)
    const token = `{{${match.kind}_${suffix}}}`
    const previous = this.tenant.entries.get(token)
    if (previous && previous.value !== match.value)
      throw new RedactionError("Redaction placeholder collision", 503)
    if (!previous) {
      const json = JSON.stringify(match.value).slice(1, -1)
      if (Buffer.byteLength(match.value) + token.length + 128 > MAX_BLOCK_BYTES)
        throw new RedactionError("Redaction memory capacity exceeded", 503)
      const bytes =
        Buffer.byteLength(match.value)
        + Buffer.byteLength(json)
        + token.length
        + 128
      reserve(this.tenant, bytes)
      this.tenant.entries.set(token, {
        value: match.value,
        json,
        kind: match.kind,
      })
      this.tenant.cache.set(token, bytes)
      this.tenant.version++
    }
    this.touch(token)
    this.allowed.set(token, this.tenant.entries.get(token)!)
    return token
  }

  maskText(text: string, json = false, secretField = false): string {
    this.tenant.touched = Date.now()
    const cache = this.textCache[Number(json) + 2 * Number(secretField)]
    const cached = cache.get(text)
    if (cached?.version === this.tenant.version) return cached.value
    const value = this.maskUncachedText(text, json, secretField)
    const bytes = 2 * (text.length + value.length)
    const previousBytes = cached ? 2 * (text.length + cached.value.length) : 0
    if (this.cachedBytes - previousBytes + bytes <= MAX_BLOCK_BYTES) {
      this.cachedBytes += bytes - previousBytes
      cache.set(text, { version: this.tenant.version, value })
    }
    return value
  }

  private maskUncachedText(
    text: string,
    json: boolean,
    secretField: boolean,
  ): string {
    const tokenSpans: Array<{ start: number; end: number }> = []
    for (const token of text.matchAll(TOKEN)) {
      const entry = this.tenant.entries.get(token[0])
      if (!entry)
        throw new RedactionError(
          "Redaction context expired or belongs to another caller; replay original input",
        )
      this.allowed.set(token[0], entry)
      this.touch(token[0])
      tokenSpans.push({
        start: token.index,
        end: token.index + token[0].length,
      })
    }
    const matches = findRedactions(text, this.config)
    if (
      this.config.secrets
      && secretField
      && text.length >= 4
      && !text.startsWith("${")
      && !tokenSpans.length
    )
      matches.push({ start: 0, end: text.length, value: text, kind: "SECRET" })
    // A secret echoed without its original `password=` context still needs protection.
    for (const entry of this.tenant.entries.values()) {
      if (entry.kind === "SECRET" && !this.config.secrets) continue
      if (entry.kind === "HOME" && !this.config.homePaths) continue
      // Plain custom words are already matched by the compiled rules. Partial
      // JSON still needs their escaped spelling, without reviving removed rules.
      if (
        entry.kind === "WORD"
        && (!json || !this.config.wordsEnabled || !this.words.has(entry.value))
      )
        continue
      const value = json ? entry.json : entry.value
      let from = 0
      while (true) {
        const start = text.indexOf(value, from)
        if (start < 0) break
        const end = start + value.length
        const pathBoundary =
          entry.kind !== "HOME"
          || end === text.length
          || /[/\\\s"'<>]/.test(text[end])
        if (pathBoundary)
          matches.push({ start, end, value: entry.value, kind: entry.kind })
        from = end
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end)
    let cursor = 0
    let output = ""
    for (const match of matches) {
      if (match.start < cursor) continue
      if (
        tokenSpans.some(
          (span) => match.start < span.end && match.end > span.start,
        )
      )
        continue
      output += text.slice(cursor, match.start) + this.placeholder(match)
      cursor = match.end
    }
    return output + text.slice(cursor)
  }

  restoreText(text: string, json = false): string {
    this.tenant.touched = Date.now()
    return text.replaceAll(TOKEN, (token) => {
      const entry = this.allowed.get(token)
      if (!entry) return token // Never disclose a different request's known secret.
      return json ? entry.json : entry.value
    })
  }

  mask<T>(value: T, issuer?: string): T {
    return transformContent(
      value,
      (text, json, secret) => this.maskText(text, json, secret),
      (node, signed) => {
        const key = digest(signed.signature)
        const replay = this.tenant.signed.get(key)
        let original = node
        if (replay) {
          this.touch(key)
          const content = coveredContent(node, signed)
          if (digest(content) === replay.visibleHash)
            original = {
              ...node,
              ...Object.fromEntries(
                signed.fields.map((field) => [
                  field,
                  replay.original[field === "functionCall" ? field : "text"],
                ]),
              ),
            }
          else if (digest(content) !== digest(replay.original))
            throw new RedactionError(
              "Signed content was edited; cannot safely replay its signature",
            )
          if (issuer && replay.issuer !== issuer)
            throw new RedactionError(
              "Signed content cannot be replayed to a different upstream",
            )
        }
        const protectedContent = coveredContent(original, signed)
        const masked = transformContent(
          protectedContent,
          (text, json, secret) => this.maskText(text, json, secret),
        )
        if (digest(masked) !== digest(protectedContent))
          throw new RedactionError(
            "Signed content requires unavailable redaction replay context",
          )
        // Traverse the remaining message fields too; a chat signature seals reasoning, not content/tools.
        return transformContent(original, (text, json, secret) =>
          this.maskText(text, json, secret),
        )
      },
    ) as T
  }

  rememberSigned(
    original: Record<string, unknown>,
    visible: Record<string, unknown>,
    signed: SignedContent,
    issuer: string,
  ): void {
    const raw = coveredContent(original, signed)
    const shown = coveredContent(visible, signed)
    if (digest(raw) === digest(shown)) return
    const key = digest(signed.signature)
    const replay = {
      original: structuredClone(raw),
      visibleHash: digest(shown),
      issuer,
    }
    const previous = this.tenant.signed.get(key)
    if (previous) {
      this.touch(key)
      if (
        digest(previous.original) !== digest(raw)
        || previous.issuer !== issuer
      )
        throw new RedactionError("Ambiguous signed replay content", 502)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(replay)) + 128
    if (bytes > MAX_BLOCK_BYTES)
      throw new RedactionError("Redaction memory capacity exceeded", 503)
    reserve(this.tenant, bytes)
    this.tenant.signed.set(key, replay)
    this.tenant.cache.set(key, bytes)
    this.touch(key)
  }

  restore<T>(value: T, issuer: string): T {
    return transformContent(
      value,
      (text, json) => this.restoreText(text, json),
      (node, signed) => {
        const visible = transformContent(node, (text, json) =>
          this.restoreText(text, json),
        ) as Record<string, unknown>
        this.rememberSigned(node, visible, signed, issuer)
        return visible
      },
    ) as T
  }
}

interface ActiveRedaction {
  scope: RedactionScope
  issuer?: string
}
const active = new AsyncLocalStorage<ActiveRedaction>()

export function maskUpstream<T>(value: T): T {
  const current = active.getStore()
  return current ? current.scope.mask(value, current.issuer) : value
}

/** Adapters and lazy search streams stay in the same scope, including final serializers. */
export function withRedactionIssuer<T>(issuer: string, run: () => T): T {
  const current = active.getStore()
  return current ? active.run({ ...current, issuer }, run) : run()
}

export function bindRedactionStream<T>(
  stream: AsyncIterable<T>,
): AsyncIterable<T> {
  const current = active.getStore()
  if (!current) return stream
  return {
    [Symbol.asyncIterator]() {
      const iterator = active.run(current, () => stream[Symbol.asyncIterator]())
      return {
        next: () => active.run(current, () => iterator.next()),
        return: () =>
          active.run(
            current,
            () =>
              iterator.return?.()
              ?? Promise.resolve({ done: true as const, value: undefined }),
          ),
        throw: (error: unknown) =>
          active.run(current, () => {
            if (iterator.throw) return iterator.throw(error)
            throw error
          }),
      }
    },
  }
}

export async function runRedactedCall<P, R extends { response: unknown }>(
  payload: P,
  c: Context | undefined,
  execute: (payload: P) => Promise<R>,
): Promise<R> {
  if (active.getStore()) return execute(maskUpstream(payload))
  const config = getSystemSettings().redaction
  if (!config.enabled) return execute(payload)
  if (process.env.SENSITIVE_WORDS?.trim())
    throw new RedactionError(
      "Disable SENSITIVE_WORDS before enabling upstream redaction",
    )
  const userId = c?.get("userId") as string | undefined
  const identity =
    userId ? `user:${userId}`
    : state.legacyApiKey ? "legacy"
    : undefined
  const scope = new RedactionScope(config, identity)
  const release = scope.acquire()
  try {
    const result = await active.run({ scope }, () =>
      execute(scope.mask(payload)),
    )
    const identityResult = result as R & {
      accountId?: string
      identity?: { connectionId: string }
    }
    const issuer =
      identityResult.identity?.connectionId ?? identityResult.accountId ?? ""
    const response = result.response
    if (
      response
      && typeof response === "object"
      && Symbol.asyncIterator in response
    ) {
      const { restoreRedactionStream } = await import("~/lib/redaction/stream")
      const restored = active.run({ scope, issuer }, () =>
        restoreRedactionStream(
          bindRedactionStream(response as AsyncIterable<unknown>),
          scope,
          issuer,
        ),
      )
      return {
        ...result,
        response: {
          [Symbol.asyncIterator]() {
            const iterator = restored[Symbol.asyncIterator]()
            return {
              async next() {
                try {
                  const item = await iterator.next()
                  if (item.done) release()
                  return item
                } catch (error) {
                  release()
                  throw error
                }
              },
              async return() {
                try {
                  return (
                    (await iterator.return?.()) ?? {
                      done: true as const,
                      value: undefined,
                    }
                  )
                } finally {
                  release()
                }
              },
            }
          },
        },
      }
    }
    try {
      return { ...result, response: scope.restore(response, issuer) }
    } finally {
      release()
    }
  } catch (error) {
    release()
    throw error
  }
}
