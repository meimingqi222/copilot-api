import type { BlacklistEntry, ClientSnapshot } from "./types"

// ── Known UA patterns (built-in) ──────────────────────────────

export const BUILTIN_UA_PATTERNS = [
  "vscode",
  "visual studio code",
  "cursor",
  "windsurf",
  "claude-code",
  "codebuff",
  "copilot",
  "github",
  "jetbrains",
  "neovim",
  "vim",
  "emacs",
  "sublime",
  "helix",
  "zed",
  "cline",
  "continue",
  "aider",
  "crush",
  "openai",
  "anthropic",
]

export const customUaWhitelist: Array<string> = []

// Suspicious thresholds
export const ERROR_RATE_THRESHOLD = 0.3
export const HIGH_FREQUENCY_THRESHOLD = 100
export const AUTH_FAILURE_THRESHOLD = 8
export const PATH_SCANNING_THRESHOLD = 8
export const BURST_WINDOW_MS = 60_000
export const BURST_REQUEST_THRESHOLD = 20
export const RECENT_WINDOW_MS = 10 * 60 * 1000
export const RECENT_REQUEST_THRESHOLD = 60
export const AUTO_BLOCK_SCORE_THRESHOLD = 80
export const MAX_SNAPSHOT_ENTRIES = 10_000
export const MAX_SNAPSHOT_PATHS = 256
export const MAX_SNAPSHOT_USERNAMES = 256
export const MAX_RECENT_REQUESTS = 4_096

// ── In-memory state ────────────────────────────────────────────

export const ipBlacklist = new Map<string, BlacklistEntry>()
export const uaBlacklist = new Map<string, BlacklistEntry>()

export const ipSnapshots = new Map<string, ClientSnapshot>()
export const uaSnapshots = new Map<string, ClientSnapshot>()

// Window for aggregation: keep last 24 hours
export const SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000
// Cleanup interval: every 10 minutes
export const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
