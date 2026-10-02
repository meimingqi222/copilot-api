import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import type { ResolvedModelPricing } from "~/lib/models-dev/types"

import snapshot from "~/lib/devin-pricing/snapshot.json"
import { buildDevinPrices, parseDevinPrices } from "~/lib/devin-pricing/parser"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"

const PRICING_URL = "https://docs.devin.ai/desktop/models.md"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 60 * 60 * 1000
const SWE_2_PROMOTION_END = Date.parse("2026-10-16T00:00:00Z")
let prices = buildDevinPrices(snapshot.models)
let refreshInFlight: Promise<void> | null = null
let retryAt = 0

function cachePath(): string {
  return path.join(PATHS.APP_DIR, "devin-model-prices.md")
}

function loadCache(filePath: string): boolean {
  try {
    prices = parseDevinPrices(readFileSync(filePath, "utf8"))
    return true
  } catch {
    return false
  }
}

interface RefreshOptions {
  filePath?: string
  fetchDocument?: () => Promise<string>
  now?: number
}

async function fetchDocument(): Promise<string> {
  const response = await fetch(PRICING_URL, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(`Devin pricing request failed (${response.status})`)
  return response.text()
}

export async function refreshDevinPricing(
  options: RefreshOptions = {},
): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  const now = options.now ?? Date.now()
  if (now < retryAt) return
  const filePath = options.filePath ?? cachePath()
  if (loadCache(filePath) && now - statSync(filePath).mtimeMs < CACHE_TTL_MS)
    return
  refreshInFlight = (async () => {
    try {
      const document = await (options.fetchDocument ?? fetchDocument)()
      const nextPrices = parseDevinPrices(document)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(`${filePath}.tmp`, document, "utf8")
      renameSync(`${filePath}.tmp`, filePath)
      prices = nextPrices
      retryAt = 0
    } catch (error) {
      retryAt = now + RETRY_MS
      logger.warn(
        "Devin pricing refresh failed; keeping last good prices",
        error,
      )
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export function initDevinPricing(): void {
  loadCache(cachePath())
  void refreshDevinPricing()
}

/** SWE SKUs are distinct products: never strip fast, lightning or effort suffixes. */
export function resolveDevinPrice(
  modelId: string,
  now = Date.now(),
): ResolvedModelPricing | null {
  let id =
    modelId
      .split("/")
      .at(-1)
      ?.trim()
      .toLowerCase()
      .replace(/(\d)\.(\d)/g, "$1-$2") ?? ""
  if (!id.startsWith("swe-")) return null
  if (id === "swe-2") id = "swe-2-high"
  if (id === "swe-1-7-max") id = "swe-1-7"
  let price = prices.get(id)
  if (!price) return null
  // A cached promotional zero must not remain free after the published expiry.
  if (
    /^swe-2-(high|medium|max)$/.test(id)
    && now >= SWE_2_PROMOTION_END
    && price.promptPricePer1k === 0
    && price.completionPricePer1k === 0
  ) {
    price = {
      promptPricePer1k: 0.003,
      completionPricePer1k: 0.015,
      cacheReadPricePer1k: 0.0003,
      cacheWritePricePer1k: 0,
      contextTierAbove: null,
    }
  }
  return { ...price, source: "devin-official" }
}

export function resetDevinPricingForTest(): void {
  prices = buildDevinPrices(snapshot.models)
  retryAt = 0
}
