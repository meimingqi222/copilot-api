import { randomUUID } from "node:crypto"

import { getStableSessionId } from "~/lib/cache/session-id-cache"

import { claudeCoworkUserAgent } from "./fingerprint"

const contextManagementBeta = "context-management-2025-06-27"
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14"
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13"
const promptCachingScopeBeta = "prompt-caching-scope-2026-01-05"
const structuredOutputsBeta = "structured-outputs-2025-12-15"
const midConversationSystemBeta = "mid-conversation-system-2026-04-07"
const advancedToolUseBeta = "advanced-tool-use-2025-11-20"
const effortBeta = "effort-2025-11-24"
const fallbackCreditBeta = "fallback-credit-2026-06-01"

const coworkUtilityBetaDefaults = [
  interleavedThinkingBeta,
  thinkingTokenCountBeta,
  contextManagementBeta,
  promptCachingScopeBeta,
  structuredOutputsBeta,
] as const

const coworkAgentBetaDefaults = [
  "claude-code-20250219",
  interleavedThinkingBeta,
  thinkingTokenCountBeta,
  contextManagementBeta,
  promptCachingScopeBeta,
  midConversationSystemBeta,
  advancedToolUseBeta,
] as const

function appendUnique(target: Array<string>, values: ReadonlyArray<string>) {
  for (const value of values) {
    const trimmed = value.trim()
    // oauth-2025-04-20 belongs to bootstrap/token requests, not the current
    // Cowork Messages beta profile. It must not be reintroduced by callers.
    if (trimmed === "oauth-2025-04-20") continue
    if (trimmed && !target.includes(trimmed)) target.push(trimmed)
  }
}

/**
 * Builds the current Cowork OAuth beta profile. Agent requests are requests
 * with tools or thinking; utility requests use the smaller utility profile.
 */
export function buildClaudeCodeBetas(
  agentRequest: boolean,
  thinkingRequestOrExtra: boolean | ReadonlyArray<string> = false,
  extraBetas: ReadonlyArray<string> = [],
): string {
  // The array form keeps compatibility with the previous helper signature;
  // callers using it were always building the agent profile.
  const legacyCall = Array.isArray(thinkingRequestOrExtra)
  const thinkingRequest = legacyCall ? false : thinkingRequestOrExtra
  const extras = legacyCall ? thinkingRequestOrExtra : extraBetas
  const effectiveAgentRequest = legacyCall ? true : agentRequest
  const betas: Array<string> = [
    ...(effectiveAgentRequest ?
      coworkAgentBetaDefaults
    : coworkUtilityBetaDefaults),
  ]
  if (effectiveAgentRequest && thinkingRequest) betas.push(effortBeta)
  if (effectiveAgentRequest) betas.push(fallbackCreditBeta)
  appendUnique(betas, extras)
  return betas.join(",")
}

function mapStainlessArch(
  arch: string,
): "x64" | "arm64" | "x86" | `other::${string}` {
  switch (arch.toLowerCase()) {
    case "amd64":
    case "x64": {
      return "x64"
    }
    case "arm64":
    case "aarch64": {
      return "arm64"
    }
    case "386":
    case "x86":
    case "ia32": {
      return "x86"
    }
    default: {
      return `other::${arch.toLowerCase()}`
    }
  }
}

function mapStainlessOs(platform: string): string {
  switch (platform.toLowerCase()) {
    case "darwin": {
      return "MacOS"
    }
    case "win32": {
      return "Windows"
    }
    case "linux": {
      return "Linux"
    }
    case "freebsd": {
      return "FreeBSD"
    }
    default: {
      return `Other::${platform.toLowerCase()}`
    }
  }
}

/** Current Cowork's static Stainless headers. */
export const claudeCodeFingerprintHeaders: Readonly<Record<string, string>> = {
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v26.3.0",
  "X-Stainless-Package-Version": "0.94.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(process.arch),
  "X-Stainless-OS": mapStainlessOs(process.platform),
  "X-Stainless-Timeout": "600",
}

const enforcedHeaderKeys = new Set(
  [
    ...Object.keys(claudeCodeFingerprintHeaders),
    "Accept",
    "Accept-Encoding",
    "Connection",
    "Content-Type",
    "anthropic-version",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-beta",
    "User-Agent",
    "x-app",
    "Authorization",
    "X-Claude-Code-Session-Id",
    "x-client-request-id",
  ].map((key) => key.toLowerCase()),
)

function getHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const normalized = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value
  }
  return undefined
}

export async function buildClaudeOAuthHeaders(options: {
  accessToken: string
  stream?: boolean
  anthropicBeta?: string
  anthropicVersion?: string
  sessionId?: string
  /** Whether this is a tool/thinking agent request. */
  agentRequest?: boolean
  /** Whether thinking/output effort is enabled. */
  thinkingRequest?: boolean
  credentialKey?: string
}): Promise<Record<string, string>> {
  const extraBetas = options.anthropicBeta?.split(",") ?? []
  const betaHeader = buildClaudeCodeBetas(
    options.agentRequest ?? true,
    options.thinkingRequest ?? false,
    extraBetas,
  )

  let sessionId = options.sessionId?.trim()
  if (!sessionId && options.credentialKey) {
    sessionId = await getStableSessionId(options.credentialKey)
  }
  if (!sessionId) sessionId = randomUUID()

  return {
    Authorization: `Bearer ${options.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betaHeader,
    "anthropic-dangerous-direct-browser-access": "true",
    Connection: "keep-alive",
    "x-app": "cli",
    ...claudeCodeFingerprintHeaders,
    "X-Claude-Code-Session-Id": sessionId,
    "x-client-request-id": randomUUID(),
    "User-Agent": claudeCoworkUserAgent,
    Accept: "application/json",
    "Accept-Encoding": options.stream ? "identity" : "gzip, deflate, br, zstd",
  }
}

export function stripEnforcedFingerprintHeaders(
  forwardedHeaders: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!forwardedHeaders) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(forwardedHeaders)) {
    if (typeof value !== "string") continue
    if (enforcedHeaderKeys.has(key.toLowerCase())) continue
    result[key] = value
  }
  return result
}

export function getForwardedHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  return getHeaderCaseInsensitive(headers, name)
}

export { claudeCodeVersion } from "./fingerprint"
