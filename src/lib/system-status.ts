/**
 * What the service is doing now: process, background jobs and each
 * connection's health. Shown on the admin "Runtime status" tab and written
 * into the diagnostic bundle, so it holds nothing secret: no credential
 * value, no refresh context, a base URL only as its origin, paths with the
 * home directory as `~`.
 */

import os from "node:os"

import { listJobs } from "~/lib/jobs"
import { redactText } from "~/lib/log-redact"
import { PATHS } from "~/lib/paths"
import { listProviderConnections } from "~/lib/provider-connections"
import { safeOrigin } from "~/lib/utils"

const startedAt = Date.now()

/** A path as it may leave this machine: the home directory as `~`. */
function shareablePath(value: string): string {
  const home = os.homedir()
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

let version: string | undefined
async function packageVersion(): Promise<string> {
  if (version) return version
  try {
    const pkg = (await Bun.file(
      new URL("../../package.json", import.meta.url),
    ).json()) as { version?: string }
    version = pkg.version ?? "unknown"
  } catch {
    version = "unknown"
  }
  return version
}

export async function runtimeStatus() {
  const memory = process.memoryUsage()
  return {
    version: await packageVersion(),
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    os: `${os.type()} ${os.release()}`,
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      systemTotal: os.totalmem(),
      systemFree: os.freemem(),
    },
    dataDir: shareablePath(PATHS.APP_DIR),
    logDir: shareablePath(PATHS.LOG_DIR),
  }
}

export function connectionHealth() {
  return listProviderConnections().map((connection) => ({
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    enabled: connection.enabled,
    origin: safeOrigin(connection.baseUrl),
    proxied: Boolean(connection.proxyUrl),
    models: connection.models?.length ?? 0,
    lastModelDiscoveryAt: connection.lastModelDiscoveryAt,
    lastModelDiscoveryError:
      connection.lastModelDiscoveryError ?
        redactText(connection.lastModelDiscoveryError)
      : undefined,
    credentials: connection.credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      enabled: credential.enabled,
      status: credential.status,
      cooldownUntil: credential.cooldownUntil,
      exhaustedAt: credential.exhaustedAt,
      lastRateLimitAt: credential.lastRateLimitAt,
      lastRateLimitReason: credential.lastRateLimitReason,
      lastErrorAt: credential.lastErrorAt,
      lastError:
        credential.lastError ? redactText(credential.lastError) : undefined,
      quota:
        credential.quota ?
          {
            fetchedAt: credential.quota.fetchedAt,
            unlimited: credential.quota.unlimited,
            remaining: credential.quota.premiumInteractionsRemaining,
          }
        : undefined,
    })),
  }))
}

export async function systemStatus() {
  return {
    generatedAt: Date.now(),
    runtime: await runtimeStatus(),
    jobs: listJobs(),
    connections: connectionHealth(),
  }
}
