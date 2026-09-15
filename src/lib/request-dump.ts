/**
 * 请求 dump：把 core API(chat / messages / responses / embeddings)的原始
 * 请求头与请求体按行写入 JSONL，用于对比不同客户端打到同一 provider 时的
 * 请求差异(ZCode vs 其他 agent)。
 *
 * 默认关闭，设置 `DUMP_REQUESTS=1` 开启；`DUMP_REQUESTS_MAX_BYTES` 可覆盖
 * 单请求体积上限(默认 8MB)，`DUMP_REQUESTS_DIR` 可覆盖输出目录。
 * dump 内含原始 body,属于敏感数据:仅用于本地短期排查,查完请关闭开关。
 *
 * 同一开关同时控制上游 wire dump(`dumpUpstreamResponsesWire`):代理实际
 * 发往上游的请求体(经 strip/replay 改写后的形态)只在上游返回失败时落盘，
 * 便于定位第三方中转的 400(如 atria 的 `upstream_error`)到底是历史回放
 * 的问题还是本轮输入的问题。控制台不打印 body 全文。
 */

import type { Context } from "hono"

import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { dateKeyFromDate, readLogRotationConfig } from "~/lib/log-rotation"
import { logger } from "~/lib/logger"
import { isCoreApiPath } from "~/lib/request-log"

const DUMP_FILE_PATTERN =
  /^request-dumps-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

/** 请求头脱敏:保留出现与长度,不落盘密钥本身。 */
const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "proxy-authorization",
])

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

let appendQueue = Promise.resolve()

export function isRequestDumpEnabled(): boolean {
  const value = process.env["DUMP_REQUESTS"]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
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

export interface RequestDumpMeta {
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
  if (!isCoreApiPath(c.req.path)) return
  if (!["PATCH", "POST", "PUT"].includes(c.req.method)) return

  try {
    const headers = collectHeaders(c)
    const maxBodyBytes = resolveMaxBodyBytes()
    const { body, bodyBytes, truncated } = await readRequestBody(
      c,
      maxBodyBytes,
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

function collectHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of c.req.raw.headers.entries()) {
    const key = name.toLowerCase()
    headers[key] =
      REDACTED_HEADER_NAMES.has(key) ? `[redacted:${value.length}]` : value
  }
  return headers
}

async function readRequestBody(
  c: Context,
  maxBodyBytes: number,
): Promise<{ body?: string; bodyBytes?: number; truncated: boolean }> {
  const declaredLength = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return {
      body: `[body omitted: ${declaredLength} bytes > ${maxBodyBytes}]`,
      bodyBytes: declaredLength,
      truncated: true,
    }
  }

  const raw = await c.req.raw.clone().text()
  const bodyBytes = Buffer.byteLength(raw, "utf8")
  if (bodyBytes <= maxBodyBytes) {
    return { body: raw, bodyBytes, truncated: false }
  }
  return { body: raw.slice(0, maxBodyBytes), bodyBytes, truncated: true }
}

function enqueueAppend(line: string, timestamp: number): Promise<void> {
  const operation = appendQueue.then(() => appendDumpLine(line, timestamp))
  appendQueue = operation.catch(() => undefined)
  return operation
}

async function appendDumpLine(line: string, timestamp: number): Promise<void> {
  const config = readLogRotationConfig()
  const dir = resolveDumpDir(config.logDir)
  await mkdir(dir, { recursive: true })
  const dateKey = dateKeyFromDate(new Date(timestamp))
  const file = await selectDumpFile(
    dir,
    dateKey,
    Buffer.byteLength(line),
    config.maxFileBytes,
  )
  await appendFile(file, line, "utf8")
}

async function selectDumpFile(
  dir: string,
  dateKey: string,
  lineBytes: number,
  maxFileBytes: number,
): Promise<string> {
  const segments = (await listDumpSegments(dir, dateKey)).sort((a, b) => a - b)
  const segment = segments.at(-1) ?? 0
  const candidate = join(dir, buildDumpFileName(dateKey, segment))
  let size = 0
  try {
    size = (await stat(candidate)).size
  } catch {
    // A missing first segment starts at size zero.
  }
  return size > 0 && size + lineBytes > maxFileBytes ?
      join(dir, buildDumpFileName(dateKey, segment + 1))
    : candidate
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

export interface UpstreamResponsesWireDump {
  connectionId: string
  model: string
  stripMode: string
  /** 无正文的形状摘要(条数/类型/tools 数),控制台可打印,落盘备用。 */
  wire: string
  /** 实际发往上游的完整 JSON(与 fetch body 完全一致)。 */
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
    const entry = {
      timestamp,
      kind: "upstream-responses",
      connectionId: dump.connectionId,
      model: dump.model,
      stripMode: dump.stripMode,
      wire: dump.wire,
      ...capSizedField("upstreamBody", dump.upstreamBody, maxBodyBytes),
      upstreamStatus: dump.upstreamStatus,
      ...capSizedField(
        "upstreamErrorBody",
        dump.upstreamErrorBody,
        Math.min(maxBodyBytes, 256 * 1024),
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
): Record<string, unknown> {
  const bodyBytes = Buffer.byteLength(value, "utf8")
  if (bodyBytes <= maxBodyBytes) {
    return { [name]: value, [`${name}Bytes`]: bodyBytes }
  }
  return {
    [name]: value.slice(0, maxBodyBytes),
    [`${name}Bytes`]: bodyBytes,
    [`${name}Truncated`]: true,
  }
}
