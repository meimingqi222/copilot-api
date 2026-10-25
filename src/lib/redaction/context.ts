import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, createHash, randomBytes } from "node:crypto"
import type { Context } from "hono"

import { inferClientAgent } from "~/lib/client-agent"
import { LocalUnavailableError } from "~/lib/error"
import { state } from "~/lib/state"
import { getSystemSettings } from "~/lib/system-config"
import {
  beginRedactionInspection,
  captureRedactionAttempt,
  captureRedactionHttp,
  emptyRedactionDiagnostics,
  finishRedactionInspection,
  redactionInspectionTokens,
  recordRedactionDiagnostics,
  updateRedactionDiagnostics,
  type RedactionRecordStatus,
  type RedactionUpstream,
  type RedactionAttempt,
} from "~/lib/redaction/diagnostics"
import {
  categoryEnabled,
  findRedactions,
  isAllowed,
  type RedactionConfig,
  type RedactionMatch,
} from "~/lib/redaction/rules"
import {
  base32,
  canonicalToken,
  loosePattern,
  tokenPattern,
} from "~/lib/redaction/token"
import {
  coveredContent,
  record,
  transformContent,
  type SignedContent,
} from "~/lib/redaction/wire"

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
  label: RedactionMatch["label"]
}
interface SignedReplay {
  original: Record<string, unknown>
  visibleHash: string
  issuer: string
}
interface Tenant {
  entries: Map<string, Entry>
  signed: Map<string, SignedReplay>
  responses: Map<string, Set<string>>
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
    tenant.responses.delete(key)
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
    responses: new Map(),
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

/** What a refusal may say about a value: its kind's usual prefix or first character, and its length. */
function valueHint(match: RedactionMatch): string {
  const head =
    match.label === "API_KEY" ?
      (/^[A-Za-z]+[-_]/.exec(match.value)?.[0] ?? match.value[0])
    : match.value[0]
  return `${head}…, ${[...match.value].length} characters`
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export class RedactionScope {
  private readonly tenant: Tenant
  private readonly allowed = new Map<string, Entry>()
  private readonly identity: string
  private readonly used = new Set<string>()
  private readonly counted = new Map<string, RedactionMatch["source"]>()
  private readonly metrics = emptyRedactionDiagnostics()
  private readonly words: Set<string>
  private readonly warned = new Set<string>()
  private readonly detected = new Set<string>()
  private readonly preview: boolean
  private readonly textCache = Array.from(
    { length: 4 },
    () => new Map<string, { version: number; value: string }>(),
  )
  private cachedBytes = 0
  private leases = 0
  readonly config: RedactionConfig

  /** `preview` reports values a `block` action would refuse instead of throwing. */
  constructor(
    config: RedactionConfig,
    identity?: string,
    options: { preview?: boolean } = {},
  ) {
    this.config = Object.freeze(config)
    Object.freeze(this.config.words)
    Object.freeze(this.config.homePrefixes)
    this.words = new Set(
      config.wordsAnyCase ?
        config.words.map((word) => word.toLowerCase())
      : config.words,
    )
    this.preview = options.preview ?? false
    this.identity = identity ?? randomBytes(16).toString("hex")
    this.tenant = tenantFor(identity)
  }

  diagnostics() {
    return structuredClone(this.metrics)
  }

  outboundPlaces(body: string): number {
    let count = 0
    for (const match of body.matchAll(tokenPattern()))
      if (this.allowed.has(match[0])) count++
    return count
  }

  inspectionMappings(tokens: Array<string>) {
    return tokens.flatMap((placeholder) => {
      const entry = this.allowed.get(placeholder)
      return entry ?
          [
            {
              placeholder,
              kind: entry.kind,
              label: entry.label,
              source: this.counted.get(placeholder) ?? "known",
              value: entry.value,
            },
          ]
        : []
    })
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

  inheritResponse(id: string): void {
    const key = `response:${id}`
    const tokens = this.tenant.responses.get(key)
    if (!tokens) return
    // Pin the conversation's mappings before any new input can evict them.
    for (const token of tokens) {
      const entry = this.tenant.entries.get(token)
      if (!entry)
        throw new RedactionError(
          "Redaction conversation context expired; resend the original unredacted context",
        )
      this.allowed.set(token, entry)
      this.touch(token)
    }
    this.touch(key)
  }

  private rememberResponse(id: string): void {
    const key = `response:${id}`
    if (this.tenant.responses.has(key)) return
    const tokens = new Set(this.allowed.keys())
    const bytes = Buffer.byteLength(key) + tokens.size * 128 + 128
    reserve(this.tenant, bytes)
    this.tenant.responses.set(key, tokens)
    this.tenant.cache.set(key, bytes)
    this.touch(key)
  }

  private token(match: RedactionMatch): string {
    const hash = createHmac("sha256", KEY)
      .update(`${this.identity}\0${match.label}\0${match.value}`)
      .digest()
    // 8 base32 characters keep prompts short; a collision within this
    // caller's mappings falls back to 16 rather than failing the request.
    for (const length of [8, 16]) {
      const token = `{{${match.label}_${base32(hash, length)}}}`
      const previous = this.tenant.entries.get(token)
      if (!previous || previous.value === match.value) return token
    }
    throw new RedactionError("Redaction placeholder collision", 503)
  }

  /** Applies the category's action: mask returns a placeholder, warn and preview-block the value itself. */
  private act(match: RedactionMatch): string {
    const action = this.config.actions[match.kind]
    const key = `${match.label}\0${match.value}`
    if (!this.detected.has(key)) {
      this.detected.add(key)
      this.metrics.detected++
      this.metrics.detectedByKind[match.kind]++
    }
    if (action === "mask") return this.placeholder(match)
    if (!this.warned.has(key)) {
      this.warned.add(key)
      if (action === "warn") {
        this.metrics.warned++
        this.metrics.warnedByKind[match.kind]++
      } else {
        this.metrics.blockedCount++
        this.metrics.blockedByKind[match.kind]++
        if (this.metrics.blocked.length < 16)
          this.metrics.blocked.push({
            label: match.label,
            hint: valueHint(match),
          })
      }
    }
    if (action === "block" && !this.preview)
      // The message names the kind and a hint, never the value.
      throw new RedactionError(
        `Request refused before sending: redaction settings block ${match.label} values and this request contains one (${valueHint(match)}). Nothing was sent upstream.`,
        400,
      )
    return match.value
  }

  private placeholder(match: RedactionMatch): string {
    const token = this.token(match)
    const previous = this.tenant.entries.get(token)
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
        label: match.label,
      })
      this.tenant.cache.set(token, bytes)
      this.tenant.version++
    }
    this.touch(token)
    this.allowed.set(token, this.tenant.entries.get(token)!)
    if (!this.counted.has(token)) {
      this.counted.set(token, match.source)
      this.metrics.total++
      this.metrics.byKind[match.kind]++
      this.metrics.byLabel[match.label] =
        (this.metrics.byLabel[match.label] ?? 0) + 1
      this.metrics.bySource[match.source]++
    }
    return token
  }

  maskText(text: string, json = false, secretField = false): string {
    const started = performance.now()
    try {
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
    } finally {
      this.metrics.maskingMs += performance.now() - started
    }
  }

  private maskUncachedText(
    text: string,
    json: boolean,
    secretField: boolean,
  ): string {
    const tokenSpans: Array<{ start: number; end: number }> = []
    for (const token of text.matchAll(tokenPattern())) {
      const entry = this.tenant.entries.get(token[0])
      // Restarted/evicted contexts and other tools can supply opaque placeholders.
      // Preserve them without granting access to another caller's original value.
      if (entry) {
        this.allowed.set(token[0], entry)
        this.touch(token[0])
      }
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
    ) {
      // Preserve existing placeholders without exempting surrounding credential bytes.
      let start = 0
      for (const span of [
        ...tokenSpans,
        { start: text.length, end: text.length },
      ]) {
        if (span.start > start)
          matches.push({
            start,
            end: span.start,
            value: text.slice(start, span.start),
            kind: "SECRET",
            label: "SECRET",
            source: "field",
          })
        start = span.end
      }
    }
    // Include values found in this text, not only earlier texts/requests: an
    // assignment followed by its bare value must be safe on the first pass too.
    const scanned = new Set<string>()
    for (const entry of [...this.tenant.entries.values(), ...matches]) {
      if (!categoryEnabled(this.config, entry.kind, entry.label)) continue
      if (isAllowed(this.config, entry.value)) continue
      // Plain custom words are already matched by the compiled rules. Partial
      // JSON still needs their escaped spelling, without reviving removed rules.
      if (
        entry.kind === "WORD"
        && (!json
          || !this.words.has(
            this.config.wordsAnyCase ? entry.value.toLowerCase() : entry.value,
          ))
      )
        continue
      const value =
        json ?
          "json" in entry ?
            entry.json
          : JSON.stringify(entry.value).slice(1, -1)
        : entry.value
      const key = `${entry.label}:${value}`
      if (scanned.has(key)) continue
      scanned.add(key)
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
          matches.push({
            start,
            end,
            value: entry.value,
            kind: entry.kind,
            label: entry.label,
            source: "known",
          })
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
      output += text.slice(cursor, match.start) + this.act(match)
      cursor = match.end
    }
    return output + text.slice(cursor)
  }

  restoreText(text: string, json = false, toolInput = false): string {
    this.tenant.touched = Date.now()
    // Models sometimes echo a placeholder with spaces inside the braces or in
    // another case; those still map back to the exact placeholder sent.
    return text.replaceAll(loosePattern(), (found, label, suffix) => {
      const token = canonicalToken(label, suffix)
      const entry = token ? this.allowed.get(token) : undefined
      if (!entry && toolInput && found === token)
        throw new RedactionError(
          "Cannot restore redacted tool input; resend the original unredacted context",
        )
      if (!entry) return found // Never disclose a different request's known secret.
      this.metrics.restored++
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
    const restored = transformContent(
      value,
      (text, json, _secret, toolInput) =>
        this.restoreText(text, json, toolInput),
      (node, signed) => {
        const visible = transformContent(
          node,
          (text, json, _secret, toolInput) =>
            this.restoreText(text, json, toolInput),
        ) as Record<string, unknown>
        this.rememberSigned(node, visible, signed, issuer)
        return visible
      },
    ) as T
    const packet = record(value)
    const response =
      (
        packet?.type === "response.completed"
        || packet?.type === "response.incomplete"
      ) ?
        record(packet.response)
      : packet
    if (typeof response?.id === "string" && Array.isArray(response.output))
      this.rememberResponse(response.id)
    return restored
  }
}

interface ActiveRedaction {
  publish?: () => void
  scope: RedactionScope
  issuer?: string
  inspection?: number
  upstreams?: Array<RedactionUpstream>
  attempts?: { entries: Array<RedactionAttempt>; truncated: boolean }
  attempt?: {
    index?: number
    metadata?: RedactionAttempt
    prepared: Set<string>
  }
}
const active = new AsyncLocalStorage<ActiveRedaction>()

export function withRedactionUpstream<T>(
  upstream: RedactionUpstream,
  payload: unknown,
  run: () => T,
): T {
  const current = active.getStore()
  if (!current) return run()
  const safe = {
    id: upstream.id.slice(0, 160),
    name: upstream.name.slice(0, 160),
    protocol: upstream.protocol.slice(0, 160),
    model: upstream.model.slice(0, 160),
  }
  if (
    current.upstreams
    && current.upstreams.length < 8
    && !current.upstreams.some(
      (item) => item.id === safe.id && item.model === safe.model,
    )
  )
    current.upstreams.push(safe)
  const index = captureRedactionAttempt(current.inspection, safe, payload)
  const metadata: RedactionAttempt = {
    upstream: safe,
    status: "running",
    bodies: [],
    truncated: false,
  }
  if (current.attempts) {
    if (current.attempts.entries.length < 16)
      current.attempts.entries.push(metadata)
    else current.attempts.truncated = true
  }
  current.publish?.()
  const finish = (status: RedactionAttempt["status"]) => {
    metadata.status = status
    current.publish?.()
  }
  try {
    const result = active.run(
      { ...current, attempt: { index, metadata, prepared: new Set() } },
      run,
    )
    if (result instanceof Promise)
      return result.then(
        (value: unknown) => {
          finish("returned")
          return value
        },
        (error: unknown) => {
          finish("failed")
          throw error
        },
      ) as T
    finish("returned")
    return result
  } catch (error) {
    finish("failed")
    throw error
  }
}

/** Only bodies prepared by our generation serializer qualify as HTTP evidence. */
export function prepareRedactionBody(body: string): string {
  const current = active.getStore()
  if (current?.attempt && current.attempt.prepared.size < 16)
    current.attempt.prepared.add(
      createHash("sha256").update(body).digest("hex"),
    )
  return body
}

export function observeRedactionHttp(body: unknown):
  | {
      response: (status: number) => void
      failed: () => void
    }
  | undefined {
  const current = active.getStore()
  if (typeof body !== "string" || !current?.attempt) return
  if (
    current.attempt.prepared.has(
      createHash("sha256").update(body).digest("hex"),
    )
  ) {
    captureRedactionHttp(current.inspection, current.attempt.index, body)
    const metadata = current.attempt.metadata
    if (!metadata) return
    if (metadata.bodies.length >= 16) {
      metadata.truncated = true
      current.publish?.()
      return
    }
    const observation: RedactionAttempt["bodies"][number] = {
      places: current.scope.outboundPlaces(body),
      status: "prepared",
    }
    metadata.bodies.push(observation)
    current.publish?.()
    return {
      response: (status) => {
        observation.status = "response"
        observation.httpStatus = status
        current.publish?.()
      },
      failed: () => {
        observation.status = "failed"
        current.publish?.()
      },
    }
  }
}

export function maskUpstream<T>(value: T): T {
  const current = active.getStore()
  if (!current) return value
  const masked = current.scope.mask(value, current.issuer)
  current.publish?.()
  return masked
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
  const releaseLease = scope.acquire()
  const inspection = beginRedactionInspection(payload)
  const startedAt = Date.now()
  const attempts = { entries: [] as Array<RedactionAttempt>, truncated: false }
  const upstreams: Array<RedactionUpstream> = []
  const client = inferClientAgent(c, payload)
  let diagnosticId: number | undefined
  let released = false
  const publish = (status: RedactionRecordStatus = "in_progress") => {
    if (released && status === "in_progress") return
    finishRedactionInspection(
      inspection,
      scope.inspectionMappings(redactionInspectionTokens(inspection)),
    )
    const route = {
      client,
      upstreams,
      attempts: attempts.entries,
      attemptsTruncated: attempts.truncated,
      startedAt,
    }
    if (diagnosticId === undefined)
      diagnosticId = recordRedactionDiagnostics(
        scope.diagnostics(),
        route,
        inspection,
        status,
      )
    else
      updateRedactionDiagnostics(
        diagnosticId,
        scope.diagnostics(),
        route,
        status,
      )
  }
  const release = (status: RedactionRecordStatus = "completed") => {
    if (released) return
    released = true
    finishRedactionInspection(
      inspection,
      scope.inspectionMappings(redactionInspectionTokens(inspection)),
    )
    releaseLease()
    publish(status)
  }
  try {
    const previousId = record(payload)?.previous_response_id
    if (typeof previousId === "string") scope.inheritResponse(previousId.trim())
    const prepared = scope.mask(payload)
    publish()
    const result = await active.run(
      { scope, inspection, upstreams, publish, attempts },
      () => execute(prepared),
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
      const restored = active.run(
        { scope, issuer, inspection, upstreams, publish, attempts },
        () =>
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
                  release("failed")
                  throw error
                }
              },
              async return() {
                try {
                  const result = (await iterator.return?.()) ?? {
                    done: true as const,
                    value: undefined,
                  }
                  release("cancelled")
                  return result
                } catch (error) {
                  release("failed")
                  throw error
                }
              },
            }
          },
        },
      }
    }
    const output = { ...result, response: scope.restore(response, issuer) }
    release()
    return output
  } catch (error) {
    release("failed")
    throw error
  }
}
