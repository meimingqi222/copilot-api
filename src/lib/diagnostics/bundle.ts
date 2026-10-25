/**
 * The diagnostic bundle: what someone helping with a problem needs, in one
 * redacted file (`copilot-api-diagnostics-<time>.json.gz`).
 *
 * Built the same way from the admin page and from `copilot-api debug
 * --bundle`, which works when the server will not start.
 *
 * Never included: prompts or request bodies (request dumps), credential
 * values, refresh contexts, the redaction word lists. Two passes keep
 * secrets out: each section drops secret fields by name, then every string
 * left in the whole bundle passes through value-level redaction; the
 * manifest counts what that second pass still had to mask.
 */

import { gzipSync } from "node:zlib"

import { isSecretKey, redactText } from "~/lib/log-redact"
import { iteratePersistedRequestLogs } from "~/lib/request-log-persist"
import { getSystemConfig } from "~/lib/system-config"
import { querySystemLogs } from "~/lib/system-log-query"
import { connectionHealth, runtimeStatus } from "~/lib/system-status"
import { listJobs } from "~/lib/jobs"
import type { LogEntry } from "~/lib/log-store"
import type { SystemLogLevel } from "~/lib/system-log-bus"

export const BUNDLE_SECTIONS = [
  "runtime",
  "config",
  "connections",
  "jobs",
  "systemLogs",
  "requests",
] as const
export type BundleSection = (typeof BUNDLE_SECTIONS)[number]

export interface BundleOptions {
  /** How far back logs go, in milliseconds. */
  sinceMs: number
  sections?: ReadonlyArray<BundleSection>
  /** Request log entries: only failed ones (default) or all. */
  requests?: "failed" | "all"
  /** Lowest system log level (default info). */
  systemLevel?: SystemLogLevel
  now?: number
}

const MAX_SYSTEM_LOGS = 20_000
const MAX_REQUESTS = 5_000

/** Environment variables this service reads; their values never leave. */
const APP_ENV =
  /^(COPILOT_API_|LOG_|DUMP_|MEMORY_DIAGNOSTICS|PORT$|API_KEY$|ADMIN_PASSWORD$|GITHUB_TOKEN|ACCOUNT_TYPE$|HTTPS?_PROXY$|NO_PROXY$|UPSTREAM_REDACTION$|SENSITIVE_WORDS$|SEARCH_ORCHESTRATION$)/i

function environmentNames(): Array<string> {
  return Object.keys(process.env)
    .filter((name) => APP_ENV.test(name) && process.env[name] !== "")
    .sort()
}

function configSnapshot() {
  const { settings, source, expiresAt } = getSystemConfig()
  const redaction = settings.redaction
  return {
    source,
    expiresAt,
    settings: {
      ...settings,
      // The user's own secret words and paths are the secret; say how many.
      redaction: {
        ...redaction,
        words: `[${redaction.words.length} words]`,
        homePrefixes: `[${redaction.homePrefixes.length} prefixes]`,
        allow: `[${redaction.allow.length} values]`,
      },
    },
  }
}

function failed(entry: LogEntry): boolean {
  return (
    (entry.statusCode ?? 0) >= 400
    || entry.outcome === "failed"
    || Boolean(entry.error ?? entry.errorSnippet ?? entry.diagnosticError)
  )
}

async function requestLogs(
  from: number,
  only: "failed" | "all",
): Promise<{ entries: Array<LogEntry>; truncated: boolean }> {
  const entries: Array<LogEntry> = []
  for await (const entry of iteratePersistedRequestLogs({
    newestFirst: true,
  })) {
    if (entry.timestamp < from) continue
    if (only === "failed" && !failed(entry)) continue
    if (entries.length === MAX_REQUESTS) return { entries, truncated: true }
    entries.push(entry)
  }
  return { entries: entries.reverse(), truncated: false }
}

/**
 * Second pass: secret-named fields blanked, every string through
 * `redactText`. Returns the copy and how many strings it had to change.
 */
function scrub(value: unknown): { value: unknown; masked: number } {
  let masked = 0
  const walk = (node: unknown, byName: boolean): unknown => {
    if (typeof node === "string") {
      const clean = redactText(node)
      if (clean !== node) masked++
      return clean
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, byName))
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(node)) {
        // A switch or a count named "secrets" is not a secret; a string is.
        if (byName && isSecretKey(key) && typeof nested === "string") {
          if (nested && !nested.startsWith("[")) masked++
          out[key] = "[redacted]"
        } else
          // The redaction settings name their categories SECRET etc. and
          // hold no credential (their word lists are counts by now).
          out[key] = walk(nested, byName && key !== "redaction")
      }
      return out
    }
    return node
  }
  return { value: walk(value, true), masked }
}

export interface DiagnosticBundle {
  manifest: {
    tool: "copilot-api"
    generatedAt: string
    since: string
    sections: Array<BundleSection>
    requests: "failed" | "all"
    systemLevel: SystemLogLevel
    counts: Record<string, number>
    truncated: Array<string>
    /** Strings the final pass still had to mask. */
    redactions: number
  }
  [section: string]: unknown
}

export async function buildDiagnosticBundle(
  options: BundleOptions,
): Promise<DiagnosticBundle> {
  const now = options.now ?? Date.now()
  const from = now - options.sinceMs
  const sections = [...(options.sections ?? BUNDLE_SECTIONS)]
  const requests = options.requests ?? "failed"
  const systemLevel = options.systemLevel ?? "info"
  const body: Record<string, unknown> = {}
  const counts: Record<string, number> = {}
  const truncated: Array<string> = []

  if (sections.includes("runtime"))
    body.runtime = { ...(await runtimeStatus()), env: environmentNames() }
  if (sections.includes("config")) body.config = configSnapshot()
  if (sections.includes("connections")) {
    const connections = connectionHealth()
    body.connections = connections
    counts.connections = connections.length
  }
  if (sections.includes("jobs")) {
    const jobs = listJobs()
    body.jobs = jobs
    counts.jobs = jobs.length
  }
  if (sections.includes("systemLogs")) {
    const { entries, more } = querySystemLogs({
      from,
      level: systemLevel,
      limit: MAX_SYSTEM_LOGS,
    })
    body.systemLogs = entries.reverse()
    counts.systemLogs = entries.length
    if (more) truncated.push("systemLogs")
  }
  if (sections.includes("requests")) {
    const result = await requestLogs(from, requests)
    body.requests = result.entries
    counts.requests = result.entries.length
    if (result.truncated) truncated.push("requests")
  }

  const { value, masked } = scrub(body)
  return {
    manifest: {
      tool: "copilot-api",
      generatedAt: new Date(now).toISOString(),
      since: new Date(from).toISOString(),
      sections,
      requests,
      systemLevel,
      counts,
      truncated,
      redactions: masked,
    },
    ...(value as Record<string, unknown>),
  }
}

export function bundleFileName(now = new Date()): string {
  return `copilot-api-diagnostics-${now.toISOString().replaceAll(/[:.]/g, "-")}.json.gz`
}

export function compressBundle(bundle: DiagnosticBundle): ArrayBuffer {
  const bytes = gzipSync(JSON.stringify(bundle, null, 2))
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
