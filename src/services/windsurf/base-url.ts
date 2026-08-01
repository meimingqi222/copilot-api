const DEFAULT_WINDSURF_BASE_URL = "https://server.codeium.com"

/** Normalizes configured and region-routed Windsurf API roots. */
export function normalizeWindsurfBaseUrl(value?: string): string {
  const trimmed = value?.trim() ?? ""
  return (trimmed || DEFAULT_WINDSURF_BASE_URL).replace(/\/+$/, "")
}
