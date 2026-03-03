# WebUI Modernization & Feature Enhancement Plan
**Date:** 2026-03-03  
**Project:** copilot-api  
**Author:** Planning Agent

---

## 1. Overview

This plan covers a full modernization of the copilot-api admin interface and the addition of four major backend features:

| Feature | Description |
|---|---|
| Modern SPA WebUI | Sidebar-navigated single-page app replacing the current `pages/index.html` |
| Multi-user API key management | Per-user keys with quota limits, enable/disable, CRUD via admin UI |
| Quota management | Per-user token usage + per-account GitHub Copilot quota dashboard |
| In-memory log viewer | Ring-buffer request/error log storage, exposed via API + filterable UI |
| Multi-account load balancing | Multiple GitHub accounts, auto-rotate on quota exhaustion, 503 when all exhausted |

### Success Criteria

- All existing proxy routes (`/chat/completions`, `/v1/messages`, `/embeddings`, etc.) continue to work unchanged for API consumers.
- Single-account / single-key startup still works with zero extra config (backward compatible).
- Admin UI at `/` is a fully reactive SPA (Alpine.js, no build step) with Gruvbox dark theme.
- All new admin APIs are protected by the existing admin session cookie.
- Tests pass; no TypeScript errors; lint clean.

### Scope Exclusions

- No OAuth / SSO for end-users (API key auth only).
- No persistent database (files + in-memory only).
- No WebSocket push (UI polls for log/quota refresh).
- No changes to the existing OpenAI/Anthropic response format.

---

## 2. Prerequisites

### Runtime / Build

- No new npm packages strictly required. Optional additions:
  - None (crypto is available via `node:crypto`; file I/O via `node:fs/promises`).
- Alpine.js v3 loaded from CDN in HTML (no build step).
- Lucide icons already used; continue via CDN script tag.

### File System

Two new persistent files will be created under `~/.local/share/copilot-api/` (path resolved via existing `PATHS` helper in `src/lib/paths.ts`):

| File | Purpose |
|---|---|
| `accounts.json` | Array of GitHub account records |
| `users.json` | Array of API user records |

### Migration Notes

- On first start after upgrade, the code reads `~/.local/share/copilot-api/github_token`, wraps it in an `Account` object, and writes `accounts.json` — no manual action needed.
- If `--api-key` CLI flag is present and `users.json` does not exist, a default `admin` user is auto-created in memory (not persisted, preserving current UX).

---

## 3. TypeScript Data Structures

These interfaces should be defined in their respective new source files.

### 3.1 Account (`src/lib/accounts.ts`)

```typescript
export interface Account {
  id: string                   // uuid v4
  label: string                // human-readable name, e.g. "work", "personal"
  githubToken: string          // raw GitHub OAuth token
  copilotToken?: string        // refreshed Copilot JWT
  copilotTokenExpiry?: number  // unix ms — when to next refresh
  quotaInfo?: QuotaSnapshot    // last-fetched quota data
  isActive: boolean            // currently the "hot" account for requests
  isExhausted: boolean         // quota used up; skip until reset
  exhaustedAt?: number         // unix ms when marked exhausted
  createdAt: number            // unix ms
}

export interface QuotaSnapshot {
  fetchedAt: number
  premiumInteractionsRemaining?: number
  premiumInteractionsTotal?: number
  chatRemaining?: number
  completionsRemaining?: number
  unlimited: boolean
}
```

### 3.2 User (`src/lib/users.ts`)

```typescript
export interface User {
  id: string             // uuid v4
  username: string       // display name / login name
  hashedApiKey: string   // SHA-256 hex of raw key
  quotaLimit: number     // max tokens per rolling window; 0 = unlimited
  usedTokens: number     // accumulated since last reset
  enabled: boolean
  role: "admin" | "user"
  createdAt: number      // unix ms
  lastUsedAt?: number
}

// Returned to the API consumer on creation only — never persisted
export interface UserWithKey extends User {
  apiKey: string         // raw key, shown once
}
```

### 3.3 Log Entry (`src/lib/log-store.ts`)

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  id: number             // monotonic counter
  timestamp: number      // unix ms
  level: LogLevel
  message: string
  userId?: string
  username?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  latencyMs?: number
  statusCode?: number
  path?: string
  error?: string
}
```

### 3.4 Updated State (`src/lib/state.ts`)

```typescript
export interface State {
  // Multi-account (replaces single githubToken / copilotToken)
  accounts: Account[]
  activeAccountIndex: number

  // Multi-user (replaces single apiKey)
  users: User[]

  // Legacy single-key compatibility (populated from --api-key flag)
  legacyApiKey?: string

  // Admin session (unchanged)
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number

  // Other existing fields (unchanged)
  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string
  manualApprove: boolean
  showToken: boolean
}
```

---

## 4. Architecture Overview

### 4.1 Request Flow (Multi-Account)

```
Client request
  → requireApiKey middleware  (validates Bearer token against state.users OR legacyApiKey)
  → sets c.var.userId / c.var.username
  → route handler calls getActiveAccount()
  → if account token expired → refreshCopilotToken(account)
  → if response is 429 / quota exhausted → markAccountExhausted(account) → switchToNextAccount()
  → if all exhausted → return 503
  → logMiddleware records entry to LogStore
```

### 4.2 Load-Balancing Strategy

- `getActiveAccount()` returns `state.accounts[state.activeAccountIndex]`.
- If that account is marked `isExhausted`, walk forward cyclically until a non-exhausted account is found.
- If all are exhausted, throw a 503 error.
- A background timer runs every **5 minutes**, calls `getCopilotUsage()` per account, and clears `isExhausted` if quota has refilled (i.e., `remaining > threshold`).
- Threshold default: `remaining <= 0` (or `!unlimited && remaining < 5` for a small safety margin).
- On HTTP 429 from upstream, immediately mark the current account exhausted and retry once on the next account within the same request.

### 4.3 SPA Frontend Architecture

```
pages/index.html  (single file, no build step)
  CDN deps:
    - Tailwind CSS (Play CDN)
    - Alpine.js v3
    - Lucide Icons

  Sections (Alpine components):
    - #app-root       global store: { currentView, session, sidebarOpen }
    - #sidebar        navigation links
    - #view-dashboard
    - #view-users
    - #view-quota
    - #view-logs
    - #view-accounts
    - #view-settings (future)
```

All section components fetch from `/admin/api/*` on mount and on manual refresh. No WebSocket; polling interval configurable per-component (default: 30s for quota, 5s for logs when auto-refresh is on).

### 4.4 Backend Route Layout (additions)

```
/admin/api/users          GET, POST
/admin/api/users/:id      PUT, DELETE
/admin/api/accounts       GET, POST
/admin/api/accounts/:id   DELETE, PUT (patch label)
/admin/api/logs           GET  (?level=&search=&limit=&offset=)
/admin/api/quota          GET  (summary: per-user usage + per-account GitHub quota)
/admin/api/dashboard      GET  (aggregated stats for dashboard cards)
```

All `/admin/api/*` routes are protected by a `requireAdminSession` middleware (reuse existing `isAuthorizedRequest` or extract it).

---

## 5. Implementation Steps

### Phase 1 — Backend: Multi-Account Support

#### Step 1.1 — Add `PATHS` entries for new files

**File:** `src/lib/paths.ts`

Add two new path constants:

```typescript
ACCOUNTS_PATH: path.join(DATA_DIR, "accounts.json"),
USERS_PATH:    path.join(DATA_DIR, "users.json"),
```

---

#### Step 1.2 — Create `src/lib/accounts.ts`

New file. Responsibilities:
- `loadAccounts()` — read `accounts.json`; on first run, migrate legacy `github_token` file into a single-element array.
- `saveAccounts()` — write `accounts.json` (pretty-print, 2-space indent).
- `getActiveAccount()` — return the active non-exhausted account or throw 503.
- `markAccountExhausted(accountId)` — set `isExhausted = true`, `exhaustedAt = Date.now()`.
- `switchToNextAccount()` — advance `state.activeAccountIndex` cyclically.
- `initAccounts(tokens?: string[])` — called from `start.ts`; if tokens passed as CLI args, create/merge accounts; otherwise `loadAccounts()`.
- `refreshCopilotToken(account)` — calls existing `getCopilotToken()` with that account's `githubToken`; updates account object.
- `scheduleQuotaRefresh()` — `setInterval` every 5 min, calls `getCopilotUsage()` per account, updates `quotaInfo`, clears `isExhausted` if quota refilled.

Key implementation detail — `getCopilotToken` in `src/services/github/get-copilot-token.ts` currently reads `state.githubToken`. It must accept an optional `githubToken` parameter (or a context object) to support per-account calls. This is addressed in Step 1.3.

```typescript
// src/lib/accounts.ts  (skeleton)
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import consola from "consola"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import type { Account } from "~/lib/accounts"

export async function loadAccounts(): Promise<void> { ... }
export async function saveAccounts(): Promise<void> { ... }
export function getActiveAccount(): Account { ... }
export function markAccountExhausted(id: string): void { ... }
export function switchToNextAccount(): Account { ... }
export async function initAccounts(tokens?: string[]): Promise<void> { ... }
export function scheduleQuotaRefresh(): void { ... }
```

---

#### Step 1.3 — Modify `src/services/github/get-copilot-token.ts`

**Change:** Add optional `githubToken?: string` parameter. If provided, use it instead of `state.githubToken`.

```typescript
export const getCopilotToken = async (githubToken?: string) => {
  const token = githubToken ?? state.githubToken
  // rest unchanged
}
```

Also update callers: `src/lib/token.ts` (existing single-account path) — pass `state.githubToken` explicitly.

---

#### Step 1.4 — Modify `src/lib/token.ts`

- Keep `setupGitHubToken()` and `setupCopilotToken()` as thin wrappers around the new `accounts.ts` functions for backward compatibility with the `auth` subcommand.
- `setupCopilotToken()` now delegates to `refreshCopilotToken(getActiveAccount())`.
- The per-account interval timers are managed inside `accounts.ts`; remove the module-level `copilotTokenRefreshTimer` from `token.ts`.

---

#### Step 1.5 — Modify `src/services/copilot/create-chat-completions.ts`

Replace `state.copilotToken` reads with `getActiveAccount().copilotToken`.

On HTTP 429 from upstream, in addition to `reportUpstreamRateLimit`:

```typescript
if (response.status === 429) {
  await reportUpstreamRateLimit(response)
  markAccountExhausted(account.id)
  // Optionally: retry once with next account (see load-balancing note)
}
```

Same change needed in `src/services/copilot/create-embeddings.ts` and any other service files that use `state.copilotToken`.

---

#### Step 1.6 — Modify `src/start.ts`

New CLI options:

```
--github-tokens   Comma-separated list of GitHub tokens (alternative to --github-token)
--tokens-file     Path to a file with one GitHub token per line
```

> **Note:** `citty` does not natively support repeated `--flag value` arguments for the same key producing an array. Use `--github-tokens "t1,t2,t3"` (comma-separated string) or `--tokens-file`.

Updated `RunServerOptions`:

```typescript
interface RunServerOptions {
  // ... existing fields ...
  githubTokens?: string   // comma-separated
  tokensFile?: string
}
```

Startup flow changes:

```
1. Collect tokens: parse --github-tokens CSV + read --tokens-file + fall back to single --github-token
2. Call initAccounts(tokens)          // replaces setupGitHubToken()
3. Call loadUsers()                   // new: load users.json
4. For each account: call refreshCopilotToken(account)  // replaces setupCopilotToken()
5. scheduleQuotaRefresh()
6. cacheModels(), cacheVSCodeVersion()  // unchanged
```

---

#### Step 1.7 — Update `src/lib/api-config.ts` (copilot headers)

`copilotHeaders(state, ...)` currently reads `state.copilotToken`. Update the function signature to accept an `Account` (or token string directly) so callers can pass the active account's token.

```typescript
export const copilotHeaders = (account: Account, enableVision: boolean) => ({
  Authorization: `Bearer ${account.copilotToken}`,
  // ... rest unchanged ...
})
```

Update all callers.

---

### Phase 2 — Backend: Multi-User API Key Management

#### Step 2.1 — Create `src/lib/users.ts`

New file. Responsibilities:
- `loadUsers()` — read `users.json`; if missing and `state.legacyApiKey` set, create an in-memory admin user (not persisted).
- `saveUsers()` — write `users.json`.
- `createUser(username, quotaLimit, role)` — generates UUID, generates 32-byte hex raw key, computes SHA-256 hash, pushes to `state.users`, saves.
- `verifyApiKey(rawKey)` — SHA-256 hash the incoming key (timing-safe), find matching user, check `enabled`, return `User | null`.
- `updateUser(id, patch)` — update fields, save.
- `deleteUser(id)` — remove, save.
- `resetApiKey(id)` — generate new key, hash, update, save, return new raw key.

```typescript
// Key hashing
import { createHash, timingSafeEqual } from "node:crypto"

const hashKey = (raw: string) =>
  createHash("sha256").update(raw).digest("hex")

const keysMatch = (raw: string, hashed: string) => {
  const a = Buffer.from(hashKey(raw), "hex")
  const b = Buffer.from(hashed, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}
```

---

#### Step 2.2 — Modify `src/lib/request-auth.ts`

The `requireApiKey` middleware becomes multi-user aware:

```typescript
export const requireApiKey: MiddlewareHandler = async (c, next) => {
  // 1. Skip public paths (unchanged)
  if (isPublicPath(c.req.path)) return next()

  // 2. Multi-user mode
  if (state.users.length > 0) {
    const raw = extractBearerToken(c)
    if (!raw) return c.json({ error: "Unauthorized" }, 401)
    const user = verifyApiKey(raw)
    if (!user) return c.json({ error: "Unauthorized" }, 401)
    if (!user.enabled) return c.json({ error: "Account disabled" }, 403)
    c.set("userId", user.id)
    c.set("username", user.username)
    return next()
  }

  // 3. Legacy single-key mode (unchanged behavior)
  if (state.legacyApiKey) {
    // existing logic
  }

  // 4. No auth configured — allow
  return next()
}
```

Update type augmentation so `c.var.userId` and `c.var.username` are typed (Hono variable declaration).

---

#### Step 2.3 — Update `tests/request-auth.test.ts`

Add test cases for:
- Multi-user mode: valid key accepted, invalid key rejected, disabled user rejected.
- Legacy mode still passes.
- Mixed mode (users configured, legacy key ignored).

---

### Phase 3 — Backend: In-Memory Log Storage

#### Step 3.1 — Create `src/lib/log-store.ts`

Ring buffer holding last N log entries (default: 1000, configurable via `LOG_BUFFER_SIZE` env var).

```typescript
const MAX_SIZE = Number(process.env["LOG_BUFFER_SIZE"] ?? 1000)

class LogStore {
  private buffer: LogEntry[] = []
  private counter = 0

  push(entry: Omit<LogEntry, "id">): void {
    if (this.buffer.length >= MAX_SIZE) this.buffer.shift()
    this.buffer.push({ id: ++this.counter, ...entry })
  }

  query(opts: { level?: LogLevel; search?: string; limit?: number; offset?: number }): LogEntry[] {
    let results = this.buffer
    if (opts.level) results = results.filter(e => e.level === opts.level)
    if (opts.search) {
      const q = opts.search.toLowerCase()
      results = results.filter(e =>
        e.message.toLowerCase().includes(q) ||
        (e.username ?? "").toLowerCase().includes(q) ||
        (e.model ?? "").toLowerCase().includes(q)
      )
    }
    const offset = opts.offset ?? 0
    const limit = opts.limit ?? 100
    return results.slice(offset, offset + limit)
  }

  count(): number { return this.buffer.length }
}

export const logStore = new LogStore()
```

---

#### Step 3.2 — Create Logging Middleware `src/lib/log-middleware.ts`

Attach after `requireApiKey` so `userId`/`username` are already set.

```typescript
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  await next()
  const latencyMs = Date.now() - start

  logStore.push({
    timestamp: Date.now(),
    level: c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info",
    message: `${c.req.method} ${c.req.path} ${c.res.status}`,
    userId: c.var.userId,
    username: c.var.username,
    latencyMs,
    statusCode: c.res.status,
    path: c.req.path,
  })
}
```

Token counts (model, promptTokens, completionTokens) are injected by the route handlers via `c.set("logMeta", {...})` before calling `next()` or via a response header trick. Simplest approach: route handlers call `logStore.push(...)` directly at the end of the request with full metadata.

---

#### Step 3.3 — Modify `src/server.ts`

Register `requestLogger` middleware:

```typescript
import { requestLogger } from "./lib/log-middleware"
server.use("*", requireApiKey)
server.use("*", requestLogger)   // after auth so userId is populated
```

---

### Phase 4 — Backend: New Admin API Endpoints

#### Step 4.1 — Create `src/routes/admin/api/users.ts`

```typescript
// GET  /admin/api/users         → list all users (strip hashedApiKey from response)
// POST /admin/api/users         → create user; body: { username, quotaLimit?, role? }
// PUT  /admin/api/users/:id     → update; body: { username?, quotaLimit?, enabled?, role? }
// DELETE /admin/api/users/:id   → delete
// POST /admin/api/users/:id/reset-key → generate new API key, returns { apiKey }
```

All handlers protected by `requireAdminSession` middleware.

---

#### Step 4.2 — Create `src/routes/admin/api/accounts.ts`

```typescript
// GET    /admin/api/accounts          → list accounts (omit raw githubToken in response)
// POST   /admin/api/accounts          → add account; body: { label } → triggers device flow
//                                       returns { userCode, verificationUri, expiresIn }
//                                       client polls POST /admin/api/accounts/poll/:deviceCode
// POST   /admin/api/accounts/poll/:dc → poll for token completion
// PUT    /admin/api/accounts/:id      → update label
// DELETE /admin/api/accounts/:id      → remove account
```

The device-code flow (existing `getDeviceCode` + `pollAccessToken`) is reused here so the UI can add new GitHub accounts without CLI access.

---

#### Step 4.3 — Create `src/routes/admin/api/logs.ts`

```typescript
// GET /admin/api/logs
// Query params: level, search, limit (max 500), offset
// Returns: { entries: LogEntry[], total: number }
```

---

#### Step 4.4 — Create `src/routes/admin/api/quota.ts`

```typescript
// GET /admin/api/quota
// Returns:
// {
//   accounts: Array<{ id, label, isActive, isExhausted, quotaInfo }>,
//   users: Array<{ id, username, usedTokens, quotaLimit, enabled }>
// }
```

---

#### Step 4.5 — Create `src/routes/admin/api/dashboard.ts`

```typescript
// GET /admin/api/dashboard
// Returns:
// {
//   activeUsers: number,      // enabled users count
//   requestsToday: number,    // log entries from logStore today
//   errorsToday: number,
//   activeAccounts: number,   // non-exhausted accounts
//   totalAccounts: number,
//   quotaSummary: { used, total, unlimited }
// }
```

---

#### Step 4.6 — Register New Routes in `src/routes/admin/route.ts`

```typescript
import { userApiRoutes }    from "./api/users"
import { accountApiRoutes } from "./api/accounts"
import { logApiRoutes }     from "./api/logs"
import { quotaApiRoutes }   from "./api/quota"
import { dashboardApiRoutes } from "./api/dashboard"

adminRoutes.use("/api/*", requireAdminSession)
adminRoutes.route("/api/users", userApiRoutes)
adminRoutes.route("/api/accounts", accountApiRoutes)
adminRoutes.route("/api/logs", logApiRoutes)
adminRoutes.route("/api/quota", quotaApiRoutes)
adminRoutes.route("/api/dashboard", dashboardApiRoutes)
```

---

#### Step 4.7 — Update `src/server.ts` to serve SPA

Change the root handler to serve `pages/index.html`:

```typescript
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const indexHtml = await readFile(resolve(import.meta.dir, "../pages/index.html"), "utf8")
server.get("/", (c) => c.html(indexHtml))
```

> **Note:** In production / bundled builds (tsdown), `pages/index.html` must be included as a static asset. Alternatively, inline the HTML as a string or serve it from a known path. Confirm `tsdown.config.ts` copies `pages/` to `dist/`.

---

### Phase 5 — Frontend: Modern SPA WebUI

#### Step 5.1 — Redesign `pages/index.html`

**Technology choices:**
- **Alpine.js v3** (CDN) for reactive data binding — no build step, lightweight (~15 KB gzipped).
- **Tailwind CSS Play CDN** — unchanged from current approach.
- **Lucide Icons** — CDN, unchanged.
- **Gruvbox Dark** color scheme — preserve existing CSS variables.

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ Header: Logo + account badge + logout button                 │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  Sidebar     │  Main Content Area                           │
│  ─────────   │                                              │
│  Dashboard   │  (Alpine x-show per active view)             │
│  Users       │                                              │
│  Quota       │                                              │
│  Logs        │                                              │
│  Accounts    │                                              │
│              │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

**Module breakdown:**

| View | Key Components |
|---|---|
| Dashboard | 4 stat cards (users, requests today, errors, active accounts); recent activity table |
| Users | Table of users with enable/disable toggle, edit modal, delete confirm, "Add User" button |
| Quota | Per-account GitHub quota bars; per-user token usage table with limit vs. used |
| Logs | Filterable table (level badge, path, user, latency, time); live auto-refresh toggle; pagination |
| Accounts | Cards per GitHub account with status badge (active/exhausted); "Add Account" triggers device-code flow in a modal |

**Alpine.js global store:**

```javascript
Alpine.store('app', {
  view: 'dashboard',  // current active view
  loading: false,
  toast: null,
  async navigate(view) {
    this.view = view
  }
})
```

**Auth guard:** On page load, call `GET /admin/api/dashboard`. If 401, redirect to `/admin/login`. If `adminPassword` is not set, the admin session is skipped (same as today).

**Color variables (Gruvbox — unchanged):**

```css
:root {
  --bg:      #282828;
  --bg1:     #3c3836;
  --bg2:     #504945;
  --fg:      #ebdbb2;
  --yellow:  #d79921;
  --green:   #98971a;
  --red:     #cc241d;
  --blue:    #458588;
  --orange:  #d65d0e;
  --purple:  #b16286;
  --aqua:    #689d6a;
}
```

---

## 6. File Changes Summary

### New Files

| Path | Purpose |
|---|---|
| `src/lib/accounts.ts` | Multi-account management (load/save/rotate/refresh) |
| `src/lib/users.ts` | Multi-user API key management (load/save/CRUD/verify) |
| `src/lib/log-store.ts` | In-memory ring-buffer log store |
| `src/lib/log-middleware.ts` | Hono middleware: capture request logs into log store |
| `src/routes/admin/api/users.ts` | REST handlers for user CRUD |
| `src/routes/admin/api/accounts.ts` | REST handlers for account CRUD + device flow |
| `src/routes/admin/api/logs.ts` | REST handler for log query |
| `src/routes/admin/api/quota.ts` | REST handler for quota summary |
| `src/routes/admin/api/dashboard.ts` | REST handler for dashboard stats |

### Modified Files

| Path | Changes |
|---|---|
| `src/lib/state.ts` | Add `accounts[]`, `activeAccountIndex`, `users[]`, `legacyApiKey`; remove `githubToken`, `copilotToken`, `apiKey` |
| `src/lib/paths.ts` | Add `ACCOUNTS_PATH`, `USERS_PATH` constants |
| `src/lib/token.ts` | Delegate to `accounts.ts`; keep `setupGitHubToken` for `auth` subcommand |
| `src/lib/request-auth.ts` | Multi-user `verifyApiKey` logic; set `c.var.userId/username` |
| `src/lib/api-config.ts` | `copilotHeaders` accepts `Account` instead of reading `state` directly |
| `src/start.ts` | New CLI args `--github-tokens`, `--tokens-file`; updated startup flow |
| `src/server.ts` | Register `requestLogger`; serve SPA at `/`; register new `/admin/api/*` sub-routes |
| `src/routes/admin/route.ts` | Mount new `/api/*` sub-router; add `requireAdminSession` guard |
| `src/routes/chat-completions/route.ts` | Use `getActiveAccount()` instead of `state.copilotToken` |
| `src/routes/messages/route.ts` | Same as above |
| `src/routes/embeddings/route.ts` | Same as above |
| `src/services/github/get-copilot-token.ts` | Accept optional `githubToken` parameter |
| `src/services/copilot/create-chat-completions.ts` | Use active account token; handle 429 → rotate |
| `pages/index.html` | Full rewrite as Alpine.js SPA (preserving file path) |
| `tsdown.config.ts` | Ensure `pages/` directory is copied/included in build output |

### Deleted Files

None — all existing files are modified in-place.

---

## 7. Detailed Implementation Order

Execute in the following order to maintain a buildable, testable state at each step:

```
[1]  src/lib/paths.ts                              — add ACCOUNTS_PATH, USERS_PATH
[2]  src/lib/state.ts                              — update State interface + initial value
[3]  src/lib/accounts.ts                           — NEW: full implementation
[4]  src/services/github/get-copilot-token.ts      — accept githubToken param
[5]  src/lib/token.ts                              — delegate to accounts.ts
[6]  src/lib/api-config.ts                         — update copilotHeaders signature
[7]  src/services/copilot/create-chat-completions.ts — use active account + 429 rotation
[8]  src/services/copilot/create-embeddings.ts     — same as [7]
[9]  src/lib/users.ts                              — NEW: full implementation
[10] src/lib/request-auth.ts                       — multi-user verify
[11] src/start.ts                                  — new CLI args + updated startup
[12] src/lib/log-store.ts                          — NEW: ring buffer
[13] src/lib/log-middleware.ts                     — NEW: Hono middleware
[14] src/server.ts                                 — register logger + SPA route
[15] src/routes/admin/api/users.ts                 — NEW
[16] src/routes/admin/api/accounts.ts              — NEW
[17] src/routes/admin/api/logs.ts                  — NEW
[18] src/routes/admin/api/quota.ts                 — NEW
[19] src/routes/admin/api/dashboard.ts             — NEW
[20] src/routes/admin/route.ts                     — mount /api/* sub-router
[21] src/routes/chat-completions/route.ts          — getActiveAccount()
[22] src/routes/messages/route.ts                  — getActiveAccount()
[23] src/routes/embeddings/route.ts                — getActiveAccount()
[24] tests/request-auth.test.ts                    — update for multi-user
[25] pages/index.html                              — full SPA rewrite
[26] tsdown.config.ts                              — include pages/ in build
```

---

## 8. Testing Strategy

### Unit Tests (update existing / add new)

| Test File | Changes |
|---|---|
| `tests/request-auth.test.ts` | Add multi-user cases: valid key, invalid key, disabled user, legacy mode still works |
| `tests/create-chat-completions.test.ts` | Mock `getActiveAccount()`; test 429 triggers account rotation |
| `tests/rate-limit.test.ts` | No change expected |

### New Test Files

| File | Tests |
|---|---|
| `tests/accounts.test.ts` | `loadAccounts` migration from legacy token; rotation logic; exhaustion/reset |
| `tests/users.test.ts` | Create/verify/delete user; hashing correctness; timing-safe comparison |
| `tests/log-store.test.ts` | Ring buffer eviction at MAX_SIZE; query filters (level, search, pagination) |
| `tests/admin-api.test.ts` | HTTP-level tests for each `/admin/api/*` endpoint (auth guard, CRUD correctness) |

### Manual Testing Steps

1. **Single-account backward compat:** Start with existing `~/.local/share/copilot-api/github_token` only — server starts, proxy works, `/usage` works.
2. **Multi-account:** Start with `--github-tokens "t1,t2"` — dashboard shows 2 accounts; exhaust one manually via mock → rotates.
3. **Multi-user:** Start, open `/admin` (or `/`), add a user → copy API key → use it in curl → request succeeds.
4. **Log viewer:** Send 10 requests of mixed success/error → open Logs view → filter by `error` level → see only errors.
5. **Device-code flow in UI:** Open Accounts view → Add Account → see user code displayed → authenticate on GitHub → account appears in list.
6. **Quota dashboard:** Open Quota view → per-account bars and per-user token counts displayed.

---

## 9. Load Balancing: Detailed Logic

```typescript
// src/lib/accounts.ts

const QUOTA_EXHAUSTION_THRESHOLD = 5  // remaining < 5 → treat as exhausted
const QUOTA_RECHECK_INTERVAL_MS  = 5 * 60 * 1000  // 5 minutes

export function getActiveAccount(): Account {
  const accounts = state.accounts.filter(a => !a.isExhausted)
  if (accounts.length === 0) {
    throw new HTTPError("All GitHub Copilot accounts are quota-exhausted", fakeResponse(503))
  }
  // Prefer the currently designated active index if not exhausted
  const preferred = state.accounts[state.activeAccountIndex]
  if (preferred && !preferred.isExhausted) return preferred
  // Otherwise return first non-exhausted
  const next = accounts[0]
  state.activeAccountIndex = state.accounts.indexOf(next)
  return next
}

export function markAccountExhausted(id: string): void {
  const account = state.accounts.find(a => a.id === id)
  if (!account) return
  account.isExhausted = true
  account.exhaustedAt  = Date.now()
  consola.warn(`Account "${account.label}" marked exhausted`)
  // Advance active index
  switchToNextAccount()
}

export function scheduleQuotaRefresh(): void {
  setInterval(async () => {
    for (const account of state.accounts) {
      try {
        // Temporarily set githubToken for getCopilotUsage call
        const usage = await getCopilotUsageForAccount(account)
        account.quotaInfo = snapshotFromUsage(usage)
        const remaining = account.quotaInfo.premiumInteractionsRemaining ?? Infinity
        const unlimited  = account.quotaInfo.unlimited
        if (account.isExhausted && (unlimited || remaining > QUOTA_EXHAUSTION_THRESHOLD)) {
          account.isExhausted = false
          consola.info(`Account "${account.label}" quota refreshed — re-activating`)
        }
      } catch (err) {
        consola.warn(`Failed to refresh quota for account "${account.label}":`, err)
      }
    }
    await saveAccounts()
  }, QUOTA_RECHECK_INTERVAL_MS)
}
```

**Retry-within-request behavior:**

When `create-chat-completions.ts` receives a 429:
1. Call `markAccountExhausted(account.id)`.
2. Get the new active account via `getActiveAccount()`.
3. If it is different from the one that just failed, **retry the same request once** with the new account's token.
4. If the retry also fails (or no other accounts), propagate the error to the client.

This keeps the P99 latency hit to one extra upstream call in the worst case.

---

## 10. API Specification

### Users API

```
GET  /admin/api/users
Response: { users: Array<Omit<User, "hashedApiKey">> }

POST /admin/api/users
Body:    { username: string, quotaLimit?: number, role?: "admin"|"user" }
Response: { user: UserWithKey }   // apiKey shown only once

PUT  /admin/api/users/:id
Body:    Partial<{ username, quotaLimit, enabled, role }>
Response: { user: Omit<User, "hashedApiKey"> }

DELETE /admin/api/users/:id
Response: { ok: true }

POST /admin/api/users/:id/reset-key
Response: { apiKey: string }      // new raw key, shown once
```

### Accounts API

```
GET  /admin/api/accounts
Response: { accounts: Array<Omit<Account, "githubToken">> }

POST /admin/api/accounts
Body:    { label: string }
Response: { deviceCode: string, userCode: string, verificationUri: string, expiresIn: number }

POST /admin/api/accounts/poll/:deviceCode
Response: { status: "pending"|"complete"|"expired", accountId?: string }

PUT  /admin/api/accounts/:id
Body:    { label: string }
Response: { account: Omit<Account, "githubToken"> }

DELETE /admin/api/accounts/:id
Response: { ok: true }
```

### Logs API

```
GET /admin/api/logs?level=error&search=gpt-4&limit=100&offset=0
Response: {
  entries: LogEntry[],
  total: number,
  limit: number,
  offset: number
}
```

### Quota API

```
GET /admin/api/quota
Response: {
  accounts: Array<{
    id, label, isActive, isExhausted,
    quotaInfo: QuotaSnapshot | null
  }>,
  users: Array<{
    id, username, usedTokens, quotaLimit, enabled
  }>
}
```

### Dashboard API

```
GET /admin/api/dashboard
Response: {
  activeUsers: number,
  totalUsers: number,
  requestsToday: number,
  errorsToday: number,
  activeAccounts: number,
  totalAccounts: number,
  bufferSize: number,        // current log entries in ring buffer
  quota: {
    unlimited: boolean,
    premiumRemaining: number | null,
    premiumTotal: number | null
  }
}
```

---

## 11. Migration & Backward Compatibility

| Scenario | Behavior |
|---|---|
| Existing single `github_token` file, no `accounts.json` | `initAccounts([])` reads `github_token`, creates `Account` with `id=uuid`, `label="default"`, writes `accounts.json`. |
| `--api-key` flag, no `users.json` | `loadUsers()` creates in-memory admin user with that key hash; nothing written to disk. Existing behavior preserved. |
| No `--api-key`, no `users.json` | `state.users = []`; `requireApiKey` passes all requests through (open mode). Unchanged. |
| `--github-token` single flag | Treated as `--github-tokens "value"` (single-element array). |
| `/token` endpoint | Still returns `getActiveAccount().copilotToken`. |
| `/usage` endpoint | Queries `getCopilotUsage()` for the active account's GitHub token. |

---

## 12. Rollback Plan

Since no breaking schema migration is required and all new persistent files are additive:

1. **Revert code** to previous git commit.
2. **Delete** `~/.local/share/copilot-api/accounts.json` and `users.json` (or keep them — old code ignores them).
3. The original `github_token` file is **never deleted or overwritten** — migration only writes `accounts.json`.
4. No database to roll back.

---

## 13. Estimated Effort

| Phase | Effort | Complexity |
|---|---|---|
| Phase 1: Multi-account backend | 3–4 days | High (state refactor, timer management, retry logic) |
| Phase 2: Multi-user API keys | 1–2 days | Medium |
| Phase 3: Log store + middleware | 0.5 day | Low |
| Phase 4: Admin API endpoints (9 routes) | 1.5 days | Medium |
| Phase 5: SPA frontend rewrite | 2–3 days | Medium-High (UI state, device-code flow UX) |
| Testing & polish | 1–2 days | Medium |
| **Total** | **9–13 days** | **High** |

---

## 14. Open Questions & Risks

| # | Question / Risk | Recommendation |
|---|---|---|
| 1 | `citty` multi-value args | Use comma-separated `--github-tokens` or `GITHUB_TOKENS` env var |
| 2 | `tsdown` / `dist/` — how to bundle static HTML | Confirm `tsdown.config.ts` supports `copy` plugin or use `Bun.file` with `import.meta.dir` for path resolution at runtime |
| 3 | Rate limiting when rotating accounts | Ensure `rate-limit.ts` tracks per-account, not globally |
| 4 | `getCopilotUsage` reads `state.githubToken` | Needs same parameterization as `getCopilotToken` |
| 5 | Token count tracking per user | `gpt-tokenizer` (already in deps) can count prompt tokens client-side; completion tokens from streaming response `usage` field |
| 6 | Admin session and new SPA root | Current root returns `c.text("Server running")`. Changing to HTML must not break health-check scripts — consider keeping `/health` as a plain text endpoint |
| 7 | Device-code poll state in-memory | Store pending device-code sessions in a `Map<deviceCode, pollState>` in `accounts.ts`; clean up after expiry |

