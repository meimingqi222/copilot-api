// ── Types ──────────────────────────────────────────────────────

export interface BlacklistEntry {
  /** The blocked value (IP address or User-Agent substring) */
  value: string
  type: "ip" | "ua"
  /** Human-readable reason */
  reason?: string
  /** Manual block or auto mitigation */
  source?: "manual" | "auto"
  /** Temporary auto blocks expire automatically */
  expiresAt?: number
  /** Risk score when the auto action was triggered */
  triggerScore?: number
  /** Machine-readable reasons that triggered the action */
  triggerReasons?: Array<string>
  /** When the entry was created (epoch ms) */
  createdAt: number
}

export interface ClientSnapshot {
  /** Unique key: ip or ua string */
  key: string
  type: "ip" | "ua"
  /** Total requests seen in the current tracking window */
  requests: number
  /** Requests that returned 4xx/5xx */
  errors: number
  /** Authentication failures (401/403) */
  authFailures: number
  /** 404 responses, usually probing or scanning */
  notFounds: number
  /** Last request timestamp */
  lastSeenAt: number
  /** First request timestamp in window */
  firstSeenAt: number
  /** Associated usernames (from auth) */
  usernames: Set<string>
  /** Associated paths */
  paths: Map<string, number>
  /** Whether this entry is currently blacklisted */
  blocked: boolean
  /** Count of requests where initiator was 'user' (premium) */
  userInitiatorCount: number
  /** Count of requests where initiator was 'agent' (non-premium) */
  agentInitiatorCount: number
  /** Recent timestamps used for burst detection */
  recentRequests: Array<number>
  /** Last suspicious or blocked request previews */
  flaggedRequests: Array<GuardRequestPreview>
}

export interface GuardRequestPreview {
  at: number
  path: string
  statusCode?: number
  preview: string
}

export interface GuardRecordResult {
  shouldCapturePreview: boolean
  blocked: boolean
  riskLevel: "low" | "medium" | "high" | "critical"
}

export interface GuardPersistence {
  blacklist?: Array<BlacklistEntry>
  uaWhitelist?: Array<string>
}

export interface SuspiciousAssessment {
  suspicious: boolean
  reasons: Array<string>
  score: number
  riskLevel: "low" | "medium" | "high" | "critical"
  recommendedAction: "allow" | "review" | "temporary_block"
  errorRate: number
  burstRequests: number
  recentRequests: number
}

export interface SuspiciousSignal {
  reason: string
  score: number
}

/** Serializable version of ClientSnapshot for API responses */
export interface ClientSnapshotDTO {
  key: string
  type: "ip" | "ua"
  requests: number
  errors: number
  authFailures: number
  notFounds: number
  lastSeenAt: number
  firstSeenAt: number
  usernames: Array<string>
  paths: Record<string, number>
  topPaths: Array<{ path: string; count: number }>
  flaggedRequests: Array<GuardRequestPreview>
  blocked: boolean
  /** Whether this client looks suspicious */
  suspicious: boolean
  /** Reasons why it's marked suspicious */
  suspiciousReasons: Array<string>
  /** Composite risk score used for UI sorting */
  suspiciousScore: number
  riskLevel: "low" | "medium" | "high" | "critical"
  recommendedAction: "allow" | "review" | "temporary_block"
  errorRate: number
  burstRequests: number
  recentRequests: number
  /** Initiator distribution */
  userInitiatorCount: number
  agentInitiatorCount: number
}
