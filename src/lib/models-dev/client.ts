import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { ModelsDevCatalog } from "~/lib/models-dev/types"

import { logger } from "~/lib/logger"
import {
  buildModelsDevPriceIndexes,
  type ModelsDevPriceIndexes,
} from "~/lib/models-dev/catalog"
import { MODELS_DEV_API_URL } from "~/lib/models-dev/provider-map"
import { PATHS } from "~/lib/paths"

const CACHE_TTL_MS = 5 * 60 * 1000
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

let indexes: ModelsDevPriceIndexes | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight: Promise<void> | null = null

function cachePath(): string {
  return PATHS.MODELS_DEV_CACHE_PATH
}

function ensureCacheDir(): void {
  mkdirSync(path.dirname(cachePath()), { recursive: true })
}

function isCacheFresh(filePath: string): boolean {
  try {
    const stat = statSync(filePath)
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS
  } catch {
    return false
  }
}

function parseCatalog(text: string): ModelsDevCatalog {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev catalog payload was empty or invalid")
  }
  return parsed as ModelsDevCatalog
}

function setCatalog(nextCatalog: ModelsDevCatalog): void {
  indexes = buildModelsDevPriceIndexes(nextCatalog)
}

function loadCatalogFromDisk(): ModelsDevCatalog | null {
  try {
    const text = readFileSync(cachePath(), "utf8")
    return parseCatalog(text)
  } catch {
    return null
  }
}

async function fetchCatalogFromNetwork(): Promise<ModelsDevCatalog> {
  const response = await fetch(MODELS_DEV_API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "copilot-api/models-dev",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(
      `models.dev request failed (${response.status}): ${await response.text().catch(() => "")}`,
    )
  }
  const text = await response.text()
  ensureCacheDir()
  writeFileSync(cachePath(), text, "utf8")
  return parseCatalog(text)
}

export function getModelsDevIndexes(): ModelsDevPriceIndexes | null {
  return indexes
}

export function setModelsDevCatalogForTest(
  nextCatalog: ModelsDevCatalog | null,
): void {
  if (!nextCatalog) {
    indexes = null
    return
  }
  setCatalog(nextCatalog)
}

export async function refreshModelsDevCatalog(force = false): Promise<void> {
  if (refreshInFlight) {
    await refreshInFlight
    return
  }

  refreshInFlight = (async () => {
    const filePath = cachePath()
    if (!force && isCacheFresh(filePath)) {
      const cached = loadCatalogFromDisk()
      if (cached) {
        setCatalog(cached)
        return
      }
    }

    try {
      const fetched = await fetchCatalogFromNetwork()
      setCatalog(fetched)
      logger.info(
        `models.dev catalog refreshed (${Object.keys(fetched).length} providers)`,
      )
    } catch (error) {
      const cached = loadCatalogFromDisk()
      if (cached) {
        setCatalog(cached)
        logger.warn("models.dev fetch failed; using cached catalog", error)
        return
      }
      logger.warn("models.dev fetch failed with no cache available", error)
    }
  })().finally(() => {
    refreshInFlight = null
  })

  await refreshInFlight
}

export function initModelsDevPricing(): void {
  ensureCacheDir()
  const cached = loadCatalogFromDisk()
  if (cached) {
    setCatalog(cached)
  }

  void refreshModelsDevCatalog(false)

  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = setInterval(() => {
    void refreshModelsDevCatalog(true)
  }, REFRESH_INTERVAL_MS)
  if (typeof refreshTimer.unref === "function") {
    refreshTimer.unref()
  }
}

export function stopModelsDevPricingForTest(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  indexes = null
  refreshInFlight = null
}
