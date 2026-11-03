import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { ModelsDevCatalog, ModelsDevModel } from "~/lib/models-dev/types"

import { everyMs, runJob } from "~/lib/jobs"
import { logger } from "~/lib/logger"
import { initDevinPricing, refreshDevinPricing } from "~/lib/devin-pricing"
import {
  buildModelsDevContextIndexes,
  buildModelsDevEffortsIndexes,
  buildModelsDevPriceIndexes,
  type ModelsDevContextIndexes,
  type ModelsDevEffortsIndexes,
  type ModelsDevPriceIndexes,
} from "~/lib/models-dev/catalog"
import { MODELS_DEV_API_URL } from "~/lib/models-dev/provider-map"
import { PATHS } from "~/lib/paths"

const CACHE_TTL_MS = 5 * 60 * 1000
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

let indexes: ModelsDevPriceIndexes | null = null
let contextIndexes: ModelsDevContextIndexes | null = null
let effortsIndexes: ModelsDevEffortsIndexes | null = null
let catalog: ModelsDevCatalog | null = null
let labs: Record<string, ModelsDevModel> = {}
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight: Promise<void> | null = null

function cachePath(): string {
  return PATHS.MODELS_DEV_CACHE_PATH
}

function labsCachePath(): string {
  return path.join(path.dirname(cachePath()), "models-dev-labs.json")
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
  for (const provider of Object.values(parsed)) {
    if (
      !provider
      || typeof provider !== "object"
      || !provider.models
      || typeof provider.models !== "object"
      || Array.isArray(provider.models)
    ) {
      throw new Error("models.dev catalog provider has no valid models map")
    }
  }
  return parsed as ModelsDevCatalog
}

function setCatalog(nextCatalog: ModelsDevCatalog): void {
  const nextIndexes = buildModelsDevPriceIndexes(nextCatalog)
  const nextContextIndexes = buildModelsDevContextIndexes(nextCatalog, labs)
  const nextEffortsIndexes = buildModelsDevEffortsIndexes(nextCatalog)
  catalog = nextCatalog
  indexes = nextIndexes
  contextIndexes = nextContextIndexes
  effortsIndexes = nextEffortsIndexes
}

/** The context-window index, or null until the catalog has loaded once. */
export function getModelsDevContextIndexes(): ModelsDevContextIndexes | null {
  return contextIndexes
}

/** The reasoning-effort index, or null until the catalog has loaded once. */
export function getModelsDevEffortsIndexes(): ModelsDevEffortsIndexes | null {
  return effortsIndexes
}

/**
 * 当前生效的 models.dev 目录原文（含每个 provider 的模型表）。
 * 价格索引只是它的一种投影；像 MiniMax Code 这类上游没有模型发现端点的
 * provider 会直接从这份目录读模型清单。
 */
export function getModelsDevCatalog(): ModelsDevCatalog | null {
  return catalog
}

function loadCatalogFromDisk(): ModelsDevCatalog | null {
  try {
    const text = readFileSync(cachePath(), "utf8")
    return parseCatalog(text)
  } catch {
    return null
  }
}

function parseLabs(text: string): Record<string, ModelsDevModel> {
  const parsed: unknown = JSON.parse(text)
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.values(parsed).some(
      (model) => !model || typeof model.id !== "string",
    )
  ) {
    throw new Error("models.dev lab catalog payload was invalid")
  }
  return parsed as Record<string, ModelsDevModel>
}

function loadLabsFromDisk(): Record<string, ModelsDevModel> | null {
  try {
    return parseLabs(readFileSync(labsCachePath(), "utf8"))
  } catch {
    return null
  }
}

async function refreshLabs(force: boolean): Promise<void> {
  if (!force && isCacheFresh(labsCachePath())) {
    const cached = loadLabsFromDisk()
    if (cached) {
      labs = cached
      return
    }
  }
  try {
    const response = await fetch(new URL("models.json", MODELS_DEV_API_URL), {
      headers: {
        Accept: "application/json",
        "User-Agent": "copilot-api/models-dev",
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(`models.dev labs request failed (${response.status})`)
    const text = await response.text()
    const parsed = parseLabs(text)
    ensureCacheDir()
    writeFileSync(labsCachePath(), text, "utf8")
    labs = parsed
  } catch (error) {
    labs = loadLabsFromDisk() ?? labs
    logger.warn(
      "models.dev labs fetch failed; keeping last good metadata",
      error,
    )
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
  const parsed = parseCatalog(text)
  ensureCacheDir()
  writeFileSync(cachePath(), text, "utf8")
  return parsed
}

export function getModelsDevIndexes(): ModelsDevPriceIndexes | null {
  return indexes
}

export function setModelsDevCatalogForTest(
  nextCatalog: ModelsDevCatalog | null,
  nextLabs: Record<string, ModelsDevModel> = {},
): void {
  labs = nextLabs
  if (!nextCatalog) {
    catalog = null
    indexes = null
    contextIndexes = null
    effortsIndexes = null
    return
  }
  setCatalog(nextCatalog)
}

async function refreshProviderCatalog(force: boolean): Promise<void> {
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
}

export async function refreshModelsDevCatalog(force = false): Promise<void> {
  if (refreshInFlight) {
    await refreshInFlight
    return
  }

  refreshInFlight = Promise.all([
    refreshProviderCatalog(force),
    refreshLabs(force),
  ])
    .then(() => {
      contextIndexes = buildModelsDevContextIndexes(catalog ?? {}, labs)
    })
    .finally(() => {
      refreshInFlight = null
    })

  await refreshInFlight
}

export function initModelsDevPricing(): void {
  initDevinPricing()
  ensureCacheDir()
  labs = loadLabsFromDisk() ?? {}
  const cached = loadCatalogFromDisk()
  if (cached) {
    setCatalog(cached)
  } else {
    contextIndexes = buildModelsDevContextIndexes({}, labs)
  }

  const info = {
    label: "models.dev pricing",
    schedule: everyMs(REFRESH_INTERVAL_MS),
  }
  void runJob("models-dev", () => refreshModelsDevCatalog(false), info).catch(
    () => {},
  )

  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = setInterval(() => {
    void runJob(
      "models-dev",
      () => Promise.all([refreshDevinPricing(), refreshModelsDevCatalog(true)]),
      info,
    ).catch(() => {})
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
  contextIndexes = null
  effortsIndexes = null
  labs = {}
  refreshInFlight = null
}
