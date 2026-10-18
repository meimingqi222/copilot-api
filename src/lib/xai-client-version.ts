import { logger } from "~/lib/logger"
import { globalTimers } from "~/lib/timer-registry"

// Match CPA: npm latest, a 10-second timeout and a three-hour refresh interval.
const VERSION_URL = "https://registry.npmjs.org/@xai-official/grok/latest"
const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000
const SERVER_FLOOR = [1, 0, 13]

export let XAI_CLI_CLIENT_VERSION = "1.0.62"
let updaterStarted = false

export async function refreshXaiClientVersion(): Promise<void> {
  try {
    const response = await fetch(VERSION_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Grok version lookup returned HTTP ${response.status}`)
    }
    const payload: unknown = await response.json()
    const version =
      payload && typeof payload === "object" && "version" in payload ?
        payload.version
      : undefined
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error("Grok version lookup returned an invalid version")
    }
    const parts = version.split(".").map(Number)
    const difference = parts.findIndex((part, i) => part !== SERVER_FLOOR[i])
    if (difference !== -1 && parts[difference]! < SERVER_FLOOR[difference]!) {
      throw new Error("Grok version lookup returned a version below 1.0.13")
    }
    if (XAI_CLI_CLIENT_VERSION !== version) {
      logger.info(`Grok CLI client version updated to ${version}`)
      XAI_CLI_CLIENT_VERSION = version
    }
  } catch (error) {
    logger.warn(
      `Grok CLI version refresh failed; keeping ${XAI_CLI_CLIENT_VERSION}`,
      error,
    )
  }
}

export function startXaiVersionUpdater(): void {
  if (updaterStarted) return
  updaterStarted = true
  void refreshXaiClientVersion()
  globalTimers.interval(() => {
    void refreshXaiClientVersion()
  }, REFRESH_INTERVAL_MS)
}
