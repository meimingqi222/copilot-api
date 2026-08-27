/**
 * Provider Presets Types
 */

import type {
  ModelEndpoint,
  ProviderProtocol,
} from "~/lib/provider-connections/types"

export interface PresetModel {
  publicId: string
  upstreamId: string
  name?: string
  endpoints?: Array<ModelEndpoint>
}

export interface ProviderPreset {
  id: string
  name: string
  category:
    | "popular"
    | "domestic"
    | "international"
    | "aggregator"
    | "local"
    | "custom"
  protocol: ProviderProtocol
  baseUrl: string
  authMode: "bearer" | "header"
  headerName?: string
  keyPlaceholder?: string
  portalUrl?: string
  description?: string
  defaultModels?: Array<PresetModel>
  discoveryEnabled?: boolean
  discoveryMode?: "merge" | "replace" | "manual-only"
  fetchable?: boolean
}
