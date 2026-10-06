/**
 * 请求 dump：把 LLM 端点的原始请求头与请求体按行写入 JSONL，用于对比不同
 * 客户端打到同一 provider 时的请求差异(ZCode vs 其他 agent)。覆盖范围由
 * `shouldDumpRequest()` 定义(trace 集合 + count_tokens / embeddings)。
 *
 * 默认关闭，设置 `DUMP_REQUESTS=1` 开启；`DUMP_REQUESTS_MAX_BYTES` 可覆盖
 * 单请求体积上限(默认 8MB)，`DUMP_REQUESTS_DIR` 可覆盖输出目录。
 * 写盘前脱敏凭证与内嵌媒体；仍含提示词和普通工具参数，属于敏感数据。
 *
 * 同一开关同时控制上游 wire dump(`dumpUpstreamResponsesWire`):代理实际
 * 发往上游的请求体(经 strip/replay 改写后的形态)只在上游返回失败时落盘，
 * 便于定位第三方中转的 400(如 atria 的 `upstream_error`)到底是历史回放
 * 的问题还是本轮输入的问题。控制台不打印 body 全文。
 */

import type { Context } from "hono"

import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { shouldDumpRequest } from "~/lib/llm-request"
import {
  dateKeyFromDate,
  maybeEnforceLogStorageLimits,
  readLogRotationConfig,
} from "~/lib/log-rotation"
import { logger } from "~/lib/logger"
import { getSystemSettings } from "~/lib/system-config"
import {
  createDumpSanitizer,
  isDumpSecretField,
  type DumpSanitizer,
} from "~/lib/request-dump-sanitizer"

const DUMP_FILE_PATTERN =
  /^request-dumps-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

/** 请求头脱敏:保留出现与长度,不落盘密钥本身。 */
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

let appendQueue = Promise.resolve()

export function isRequestDumpEnabled(): boolean {
  return getSystemSettings().requestDump
}

function resolveMaxBodyBytes(): number {
  const parsed = Number.parseInt(
    process.env["DUMP_REQUESTS_MAX_BYTES"] ?? "",
    10,
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES
}

function resolveDumpDir(logDir: string): string {
  const fromEnv = process.env["DUMP_REQUESTS_DIR"]?.trim()
  return fromEnv || logDir
}

interface RequestDumpMeta {
  requestId: string
  clientIp?: string
}

/**
 * Dump 一次请求的头与体。必须在 handler 消费 body 之前调用(中间件里
 * `await next()` 之前),否则 clone 拿不到完整 body。失败只告警,不影响请求。
 */
export async function dumpIncomingRequest(
  c: Context,
  meta: RequestDumpMeta,
): Promise<void> {
  if (!isRequestDumpEnabled()) return
  if (!shouldDumpRequest({ method: c.req.method, path: c.req.path })) return

  try {
    // 头和体共用一个 sanitizer scope：头部先记住自己的凭证，读体后再把体内
    // 出现的凭证并进来。这样只建一次实例，header 也只遍历一遍。
    const sanitizer = createDumpSanitizer([
      JSON.stringify(Object.fromEntries(c.req.raw.headers)),
    ])
    const headers = collectHeaders(c, sanitizer)
    const maxBodyBytes = resolveMaxBodyBytes()
    const { body, bodyBytes, truncated } = await readRequestBody(
      c,
      maxBodyBytes,
      sanitizer,
    )
    const entry = {
      timestamp: Date.now(),
      requestId: meta.requestId,
      method: c.req.method,
      path: c.req.path,
      clientIp: meta.clientIp,
      userAgent: headers["user-agent"],
      contentLength: headers["content-length"],
      headers,
      bodyBytes,
      truncated,
      body,
    }
    await enqueueAppend(`${JSON.stringify(entry)}\n`, entry.timestamp)
  } catch (error) {
    logger.warn("[request-dump] failed to dump request:", error)
  }
}

function collectHeaders(
  c: Context,
  sanitizer: DumpSanitizer,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of c.req.raw.headers.entries()) {
    const key = name.toLowerCase()
    headers[key] =
      isDumpSecretField(key) ?
        `[redacted:${value.length}]`
      : sanitizer.text(value)
  }
  return headers
}

async function readRequestBody(
  c: Context,
  maxBodyBytes: number,
  sanitizer: DumpSanitizer,
): Promise<{ body?: string; bodyBytes?: number; truncated: boolean }> {
  const declaredLength = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return {
      body: `[body omitted: ${declaredLength} bytes > ${maxBodyBytes}]`,
      bodyBytes: declaredLength,
      truncated: true,
    }
  }

  // 没有可信的 Content-Length 时也不整读：第一个跨过上限的 chunk 到达后就停，
  // 超限直接记「已截断」而不是先把一个可能几百 MB 的 body 全部拉进内存。
  const { raw, bytesRead, overflow } = await readBodyBounded(c, maxBodyBytes)
  if (overflow) {
    return {
      body: `[body omitted: exceeds ${maxBodyBytes} bytes]`,
      bodyBytes: bytesRead,
      truncated: true,
    }
  }
  const bodyBytes = bytesRead
  // 体内可能回显 header 里的凭证，读体后并入同一个 scope 再脱敏。
  sanitizer.addSecrets(raw)
  const body = sanitizer.json(raw)
  if (Buffer.byteLength(body) <= maxBodyBytes)
    return { body, bodyBytes, truncated: false }
  return {
    body: "[body omitted: redacted body exceeds limit]",
    bodyBytes,
    truncated: true,
  }
}

async function readBodyBounded(
  c: Context,
  maxBodyBytes: number,
): Promise<{ raw: string; bytesRead: number; overflow: boolean }> {
  const body = c.req.raw.clone().body
  if (!body) return { raw: "", bytesRead: 0, overflow: false }
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let bytesRead = 0
  let overflow = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBodyBytes) {
        overflow = true
        break
      }
      chunks.push(value)
    }
  } finally {
    // A cloned request is a tee. Awaiting cancellation waits for the original
    // branch too, which the route may not read until the dump has finished.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (overflow) return { raw: "", bytesRead, overflow }
  const whole = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    whole.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    raw: new TextDecoder().decode(whole),
    bytesRead,
    overflow,
  }
}

function enqueueAppend(line: string, timestamp: number): Promise<void> {
  const operation = appendQueue.then(() => appendDumpLine(line, timestamp))
  appendQueue = operation.catch(() => undefined)
  return operation
}

/**
 * 当前写入的文件及其已知大小。每行都 readdir+stat 一次代价不小，
 * 追加写入是唯一写者，所以行尾追加后大小可直接累加；目录或日期
 * 变了、追加失败时回退到全量扫描。
 */
let currentDumpFile:
  | { dir: string; dateKey: string; file: string; size: number }
  | undefined

async function appendDumpLine(line: string, timestamp: number): Promise<void> {
  const config = readLogRotationConfig()
  const dir = resolve(resolveDumpDir(config.logDir))
  await mkdir(dir, { recursive: true })
  const dateKey = dateKeyFromDate(new Date(timestamp))
  const lineBytes = Buffer.byteLength(line)

  let file: string
  let size: number
  if (
    currentDumpFile
    && currentDumpFile.size + lineBytes <= config.maxFileBytes
    && currentDumpFile.dir === dir
    && currentDumpFile.dateKey === dateKey
  ) {
    file = currentDumpFile.file
    size = currentDumpFile.size
  } else {
    const selected = await selectDumpFile(
      dir,
      dateKey,
      lineBytes,
      config.maxFileBytes,
    )
    file = selected.file
    size = selected.size
  }
  try {
    await appendFile(file, line, "utf8")
  } catch {
    // 文件可能被外部轮转/删除，清缓存重扫一次再写。
    currentDumpFile = undefined
    const selected = await selectDumpFile(
      dir,
      dateKey,
      lineBytes,
      config.maxFileBytes,
    )
    await appendFile(selected.file, line, "utf8")
    currentDumpFile = {
      dir,
      dateKey,
      file: selected.file,
      size: selected.size + lineBytes,
    }
    if (maybeEnforceLogStorageLimits(config, lineBytes))
      currentDumpFile = undefined
    return
  }
  currentDumpFile = { dir, dateKey, file, size: size + lineBytes }
  if (maybeEnforceLogStorageLimits(config, lineBytes))
    currentDumpFile = undefined
}

async function selectDumpFile(
  dir: string,
  dateKey: string,
  lineBytes: number,
  maxFileBytes: number,
): Promise<{ file: string; size: number }> {
  const segments = (await listDumpSegments(dir, dateKey)).sort((a, b) => a - b)
  const segment = segments.at(-1) ?? 0
  const candidate = join(dir, buildDumpFileName(dateKey, segment))
  let size = 0
  try {
    size = (await stat(candidate)).size
  } catch {
    // A missing first segment starts at size zero.
  }
  if (size > 0 && size + lineBytes > maxFileBytes) {
    return { file: join(dir, buildDumpFileName(dateKey, segment + 1)), size: 0 }
  }
  return { file: candidate, size }
}

async function listDumpSegments(
  dir: string,
  dateKey: string,
): Promise<Array<number>> {
  try {
    return (await readdir(dir)).flatMap((name) => {
      const match = DUMP_FILE_PATTERN.exec(name)
      return match?.[1] === dateKey ? [Number(match[2] ?? 0)] : []
    })
  } catch {
    return []
  }
}

export function buildDumpFileName(dateKey: string, segment: number): string {
  return segment === 0 ?
      `request-dumps-${dateKey}.jsonl`
    : `request-dumps-${dateKey}.${segment}.jsonl`
}

interface UpstreamResponsesWireDump {
  connectionId: string
  model: string
  stripMode: string
  /** 无正文的形状摘要(条数/类型/tools 数),控制台可打印,落盘备用。 */
  wire: string
  /** 实际发往上游的 JSON，写盘前脱敏，不修改 fetch body。 */
  upstreamBody: string
  upstreamStatus: number
  /** 上游错误原文(截断上限内全量)。 */
  upstreamErrorBody: string
}

/**
 * 上游失败时的 wire 落盘:只在 `DUMP_REQUESTS=1` 时写入,与 incoming dump
 * 同目录(`request-dumps-*.jsonl`,`kind: "upstream-responses"`)。
 * 只在失败路径调用,成功请求不落盘。失败只告警,不影响错误本身的抛出。
 */
export async function dumpUpstreamResponsesWire(
  dump: UpstreamResponsesWireDump,
): Promise<void> {
  if (!isRequestDumpEnabled()) return
  try {
    const maxBodyBytes = resolveMaxBodyBytes()
    const timestamp = Date.now()
    const sanitizer = createDumpSanitizer([
      dump.upstreamBody,
      dump.upstreamErrorBody,
    ])
    const entry = {
      timestamp,
      kind: "upstream-responses",
      connectionId: dump.connectionId,
      model: dump.model,
      stripMode: dump.stripMode,
      wire: sanitizer.text(dump.wire),
      ...capSizedField(
        "upstreamBody",
        sanitizer.json(dump.upstreamBody),
        maxBodyBytes,
        Buffer.byteLength(dump.upstreamBody),
      ),
      upstreamStatus: dump.upstreamStatus,
      ...capSizedField(
        "upstreamErrorBody",
        sanitizer.error(dump.upstreamErrorBody),
        Math.min(maxBodyBytes, 256 * 1024),
        Buffer.byteLength(dump.upstreamErrorBody),
      ),
    }
    await enqueueAppend(`${JSON.stringify(entry)}\n`, timestamp)
  } catch (error) {
    logger.warn("[request-dump] failed to dump upstream wire:", error)
  }
}

/** 按字节上限截断落盘字段,超限标记 `<name>Truncated` 并保留原始字节数。 */
function capSizedField(
  name: "upstreamBody" | "upstreamErrorBody",
  value: string,
  maxBodyBytes: number,
  bodyBytes: number,
): Record<string, unknown> {
  const oversized =
    bodyBytes > maxBodyBytes || Buffer.byteLength(value) > maxBodyBytes
  if (!oversized) {
    return { [name]: value, [`${name}Bytes`]: bodyBytes }
  }
  return {
    [name]: Buffer.from(value)
      .subarray(0, maxBodyBytes)
      .toString("utf8")
      .replace(/\uFFFD$/, ""),
    [`${name}Bytes`]: bodyBytes,
    [`${name}Truncated`]: true,
  }
}
