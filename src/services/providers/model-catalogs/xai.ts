import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

const XAI_CATALOG: Array<CatalogEntry> = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 0309 Reasoning",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 0309 Non Reasoning",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi Agent 0309",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    vendor: "xai",
    upstreamId: "grok-build-0.1",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-3-mini-fast",
    name: "Grok 3 Mini Fast",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5 Fast",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-imagine-image",
    name: "Grok Imagine Image",
    vendor: "xai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "grok-imagine-image-quality",
    name: "Grok Imagine Image Quality",
    vendor: "xai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "grok-imagine-video",
    name: "Grok Imagine Video",
    vendor: "xai",
    supportedEndpoints: ["/v1/videos/generations"],
  },
  {
    id: "grok-imagine-video-1.5-preview",
    name: "Grok Imagine Video 1.5 Preview",
    vendor: "xai",
    supportedEndpoints: ["/v1/videos/generations"],
  },
]

function compareVersionArrays(a: Array<number>, b: Array<number>): number {
  const maxLength = Math.max(a.length, b.length)
  for (let i = 0; i < maxLength; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

function parseVersionArray(version: string): Array<number> {
  return version
    .split(".")
    .map(Number)
    .filter((value) => Number.isFinite(value))
}

function resolveLatestGrokBuildModelId(): string {
  let latest: string = "grok-build-0.1"
  let latestVersion: Array<number> = [0, 1]
  for (const entry of XAI_CATALOG) {
    if (!entry.id.startsWith("grok-build-")) continue
    const versionPart = entry.id.slice("grok-build-".length)
    const version = parseVersionArray(versionPart)
    if (version.length === 0) continue
    if (compareVersionArrays(version, latestVersion) > 0) {
      latestVersion = version
      latest = entry.id
    }
  }
  return latest
}

export function resolveXaiModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === "grok-build") {
    return resolveLatestGrokBuildModelId()
  }
  return modelId
}

export function getXaiFallbackModels(): Array<ModelMapping> {
  return toModelMappings(XAI_CATALOG)
}
