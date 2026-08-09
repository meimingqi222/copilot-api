# AGENTS.md

## Project Overview

**copilot-api** is a reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. Built with Bun, Hono, and TypeScript.

**Key features:**
- OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`)
- Anthropic-compatible endpoints (`/v1/messages`, `/v1/messages/count_tokens`)
- Multi-account support for load balancing
- Adaptive rate limiter that handles upstream 429s
- Admin dashboard for monitoring usage
- Manual request approval mode

## Build, Lint, and Test Commands

- **Build:**  
  `bun run build` (uses tsdown)
- **Dev:**  
  `bun run dev` (uses `bun --watch`)
- **Lint:**  
  `bun run lint` (uses @echristian/eslint-config)
- **Lint all files:**  
  `bun run lint:all`
- **Lint & Fix staged files:**  
  `bunx lint-staged`
- **Test all:**  
  `bun test`
- **Test single file:**  
  `bun test tests/anthropic-request.test.ts`
- **Type check:**  
  `bun run typecheck`
- **Start (prod):**  
  `bun run start`
- **Release:**  
  `bun run release` (runs bumpp + publish)

## Code Organization

```
src/
├── main.ts                 # CLI entry point (citty subcommands)
├── start.ts                # Start command implementation
├── auth.ts                 # Auth command implementation
├── debug.ts                # Debug command implementation
├── server.ts               # Hono server setup + routes
├── lib/                    # Core utilities and middleware
│   ├── accounts.ts         # Account types + getter/setter compat layer
│   ├── account-store.ts    # Account persistence (delegates to provider-connections)
│   ├── account-adapter.ts  # Account ↔ Connection bidirectional mapper
│   ├── account-availability.ts # Account availability/cooldown checks
│   ├── api-config.ts       # API configuration
│   ├── approval.ts         # Manual approval logic
│   ├── error.ts            # HTTPError class + forwardError handler
│   ├── id-sanitizer.ts     # Request ID sanitization
│   ├── initiator-header.ts # Copilot API headers
│   ├── log-middleware.ts   # Request logging
│   ├── log-store.ts        # Log storage
│   ├── paths.ts            # File paths (data directory)
│   ├── provider-connections/ # Provider Connection system (new truth source)
│   │   ├── types.ts        # ProviderConnection, ApiCredential, RouteTarget types
│   │   ├── state.ts        # stateRoot.connections + mutation helpers
│   │   ├── store.ts        # Disk persistence (provider-connections.json)
│   │   ├── connection-to-account.ts # Connection → Account reverse mapper
│   │   ├── connection-metadata.ts   # AccountLegacyMetadata typed readers/writers
│   │   ├── migrate-from-accounts.ts # Account → Connection migration
│   │   └── availability.ts # Credential availability checks
│   ├── proxy.ts            # Proxy configuration
│   ├── rate-limit.ts       # Adaptive rate limiter
│   ├── request-admission.ts # Route target resolution + admission
│   ├── request-auth.ts     # API key authentication
│   ├── route-target/       # RouteTarget building + selection
│   │   ├── build.ts        # buildRouteTargets (connections + virtual account connections)
│   │   └── select.ts       # selectRouteTarget (priority/weight selection)
│   ├── shell.ts            # Shell script generation
│   ├── state.ts            # Global state (no state.accounts — use listAccounts())
│   ├── stats-store.ts      # Usage statistics
│   ├── token.ts            # GitHub token management
│   ├── tokenizer.ts        # Token counting
│   ├── users.ts            # User management
│   └── utils.ts            # Shared utilities
├── services/               # External API clients
│   ├── protocols/          # Protocol adapters (copilot-native, claude-native, etc.)
│   ├── copilot/            # Copilot API calls
│   ├── dispatch/           # Request dispatch + failover
│   └── providers/          # Provider registry + delegation
└── routes/                 # API route handlers
    ├── chat-completions/   # OpenAI-compatible chat
    ├── messages/           # Anthropic-compatible messages
    ├── models/             # Model listing
    ├── embeddings/         # Embeddings endpoint
    ├── responses/          # OpenAI Responses API
    └── admin/              # Admin dashboard API
```

### Provider Connection Architecture (Step D refactor)

The codebase is mid-refactor from an Account-centric model to a
Provider Connection-centric model. Key concepts:

- **ProviderConnection**: The truth source for upstream service configuration.
  Stored in `provider-connections.json`. Each connection has protocol,
  credentials, models, baseUrl, etc.
- **Account helpers** (`src/lib/accounts.ts`): `listAccounts()` and
  `getAccount(id)` derive Account snapshots on-demand from
  `listProviderConnections()` (filtered by `readAccountLegacyMetadata`).
  `state.accounts` / `state.activeAccountIndex` fields were **deleted** in
  T5.2.2d — all reads go through `listAccounts()`/`getAccount()`, all
  mutations go through connection helpers (`upsertProviderConnection`,
  `removeProviderConnection`, `getMutableProviderConnection`).
- **RouteTarget**: The dispatch unit. `RouteTarget.account` field was deleted
  in T5.2.3. Protocol adapters derive Account from connection via
  `connectionToAccount(connection)`.
- **AccountLegacyMetadata**: Stored in `connection.metadata`, holds
  account-specific fields during the transition. Typed readers/writers in
  `connection-metadata.ts`.
- **Persistence**: `saveAccounts()` delegates to
  `saveProviderConnections(listProviderConnections())`. `accounts.json` is
  never revived — on startup, if `accounts.json` exists alongside
  `provider-connections.json`, connections take priority (set
  `COPILOT_API_FORCE_REMIGRATE=1` to re-migrate from accounts.json).

## CLI Structure

The CLI uses `citty` with subcommands:

```bash
copilot-api start     # Start the server (default)
copilot-api auth      # Run auth flow without starting server
copilot-api debug     # Show diagnostic info
```

### Start command options

| Option | Description | Default |
|--------|-------------|---------|
| `--port`, `-p` | Port to listen on | 4141 |
| `--verbose`, `-v` | Enable verbose logging | false |
| `--account-type`, `-a` | Account type (individual/business/enterprise) | individual |
| `--manual` | Enable manual request approval | false |
| `--github-token`, `-g` | Provide GitHub token directly | - |
| `--github-tokens` | Comma-separated list of tokens | - |
| `--tokens-file` | Path to file with tokens (one per line) | - |
| `--claude-code`, `-c` | Generate Claude Code command | false |
| `--show-token` | Show tokens in logs | false |
| `--api-key` | Require Bearer token auth | - |
| `--admin-password` | Admin dashboard password | API_KEY |
| `--proxy-env` | Use proxy from environment | false |

## Code Style Guidelines

- **Imports:**  
  Use ESNext syntax. **Always** use absolute imports via `~/*` for `src/*` (configured in `tsconfig.json`).
  
  ```typescript
  // ✅ Good
  import { state } from "~/lib/state"
  import { HTTPError } from "~/lib/error"
  
  // ❌ Bad
  import { state } from "./lib/state"
  ```

- **Formatting:**  
  Follows Prettier (with `prettier-plugin-packagejson`). Run `bun run lint` to auto-fix.

- **Types:**  
  Strict TypeScript (`strict: true`). **Avoid `any`** — use explicit types and interfaces.

- **Naming:**  
  `camelCase` for variables/functions, `PascalCase` for types/classes/interfaces.

- **Error Handling:**  
  Use explicit error classes (see `src/lib/error.ts`). Never swallow errors silently.

- **Unused:**  
  Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).

- **Switches:**  
  No fallthrough in switch statements.

- **Modules:**  
  Use ESNext modules, **no CommonJS** (`require`/`module.exports`).

- **Functions:**  
  Keep params ≤3 (eslint rule `max-params`). Extract options into an object if needed.

- **Function length:**  
  Lint enforces reasonable line limits (except in tests).

## Testing Patterns

- **Test runner:** Bun's built-in test runner
- **Location:** `tests/*.test.ts`
- **Naming:** `*.test.ts`
- **Imports:** Use `~/*` for src imports
- **Patterns:**
  - Use `describe`/`test`/`expect` from `bun:test`
  - Test edge cases and error conditions
  - Use Zod schemas for validation tests (see `tests/anthropic-request.test.ts`)
  - Test both streaming and non-streaming paths

```typescript
import { describe, test, expect } from "bun:test"

describe("feature name", () => {
  test("should do something", () => {
    expect(result).toBe(expected)
  })
})
```

## Key Patterns & Conventions

### State Management

Global state is stored in `src/lib/state.ts` using a singleton pattern. Access via `state` import:

```typescript
import { state } from "~/lib/state"

// Read
const token = state.githubToken
const models = state.models

// Write
state.manualApprove = true
```

### Error Handling

Use `HTTPError` for upstream errors and `forwardError` for responses:

```typescript
import { HTTPError, forwardError } from "~/lib/error"

try {
  const response = await fetch(url)
  if (!response.ok) {
    throw new HTTPError("Request failed", response, await response.text())
  }
} catch (error) {
  return forwardError(c, error)
}
```

### Rate Limiting

The adaptive rate limiter in `src/lib/rate-limit.ts`:
- Allows burst of 8 requests
- Spaces requests 250ms apart
- Increases backoff exponentially on 429s (max 60s)
- Respects `Retry-After` headers

```typescript
import { checkRateLimit, reportUpstreamRateLimit, reportUpstreamSuccess } from "~/lib/rate-limit"

await checkRateLimit(signal)
// ... make request ...
if (response.status === 429) {
  await reportUpstreamRateLimit(response)
} else {
  await reportUpstreamSuccess()
}
```

### Authentication

API key auth is handled in `src/lib/request-auth.ts` as Hono middleware:

```typescript
import { requireApiKey } from "~/lib/request-auth"

server.use("*", requireApiKey)
```

### Multi-account Support

Accounts are managed in `src/lib/accounts.ts`. Each account has:
- `githubToken`: GitHub personal access token
- `copilotToken`: Copilot JWT
- `label`: Display name

```typescript
import { getActiveAccount, refreshCopilotToken } from "~/lib/accounts"

const account = getActiveAccount()
await refreshCopilotToken(account)
```

### Request Translation

OpenAI **Chat Completions is the hub format** — every client protocol translates
to and from it, never directly to another client protocol
(`docs/translation-conventions.md`, rule R1).

- `src/services/protocols/anthropic/non-stream-translation.ts` — Messages ↔ Chat
- `src/services/protocols/anthropic/stream-translation.ts` — Chat stream → Messages stream
- `src/services/protocols/openai/chat-to-messages.ts` — Chat → Messages (request)
- `src/services/protocols/openai/messages-to-chat.ts` — Messages → Chat (response)
- `src/services/copilot/chat-to-responses.ts` / `responses-to-chat.ts` — Chat ↔ Responses
- `src/routes/chat-completions/normalize.ts` — OpenAI payload normalization
- `src/services/protocols/{chat-via-messages,chat-via-responses,messages-via-chat,responses-via-chat}.ts`
  — cross-protocol adapters the dispatch layer picks when the route target's
  endpoint differs from the requested one

> **Before touching any of these, read
> [`docs/protocol-translation-pitfalls.md`](docs/protocol-translation-pitfalls.md).**
> It records the irreducible losses in the Chat/Messages/Responses matrix (do
> **not** try to "fix" those) and the bugs already fixed there with the tests
> that lock them down (do **not** regress those). It also covers prompt-cache
> breakpoint placement on translated payloads and why `messages ↔ responses`
> has no direct path.

## Important Gotchas

### 1. Billing Header Stripping

Anthropic requests may include `x-anthropic-billing-header` in the system message. This **must** be stripped before forwarding to Copilot:

```typescript
// From src/routes/messages/non-stream-translation.ts
if (system.includes("x-anthropic-billing-header:")) {
  system = system.split("\n\n").slice(1).join("\n\n")
}
```

### 2. Thinking Blocks

Anthropic's `thinking` blocks in assistant messages must be:
- Stripped from historical messages (not sent to Copilot)
- Preserved only in the final response
- Converted to OpenAI's `reasoning_text` field

Reasoning arrives under three spellings — `reasoning_text`, `reasoning_content`,
`reasoning` — and streaming and non-streaming paths must accept the same set.
Only signed thinking can round-trip back to an Anthropic upstream, and a
signature is only valid for the exact text it was issued for, so a turn with
several thinking blocks must keep them separate (`reasoning_details`). See
[`docs/protocol-translation-pitfalls.md`](docs/protocol-translation-pitfalls.md)
§2.2, §3.4 and §3.5.

### 3. Model Name Normalization

Claude model names with numeric snapshot suffixes are normalized:
- `claude-sonnet-4-20250514` → `claude-sonnet-4`
- `claude-sonnet-4-6` → stays as-is (minor version)
- `claude-sonnet-4-x` → stays as-is (non-numeric)

### 4. Token Refresh

Copilot tokens expire and must be refreshed. The refresh logic in `src/lib/accounts.ts`:
- Schedules automatic refresh before expiry
- Handles refresh failures gracefully
- Syncs with legacy `state.githubToken` for backward compat

### 5. Signal Propagation

Always pass `AbortSignal` through async operations:
- Allows request cancellation
- Prevents memory leaks
- Required for rate limiter

```typescript
async function doSomething(signal?: AbortSignal) {
  await checkRateLimit(signal)
  const response = await fetch(url, { signal })
}
```

### 6. Path Aliases

**Always** use `~/*` for imports from `src/`. Relative imports are discouraged:

```typescript
// ✅ Good
import { PATHS } from "~/lib/paths"

// ❌ Avoid
import { PATHS } from "../../lib/paths"
```

### 7. Environment Variables

Key environment variables (see `.env.example`):
- `PORT` — Server port (default: 4141)
- `API_KEY` — Bearer token for API auth
- `ADMIN_PASSWORD` — Admin dashboard password
- `GITHUB_TOKEN` — Skip auth with provided token
- `ACCOUNT_TYPE` — individual/business/enterprise
- `HTTP_PROXY`/`HTTPS_PROXY` — Proxy configuration

### 8. Data Directory

User data (tokens, logs, stats) is stored in:
- **Linux/macOS:** `~/.local/share/copilot-api`
- **Windows:** `%APPDATA%/copilot-api`

Paths are defined in `src/lib/paths.ts`.

## CI/CD

The CI workflow (`.github/workflows/ci.yml`) runs on push/PR:
1. Install dependencies (`bun install`)
2. Lint (`bun run lint:all`)
3. Type check (`bun run typecheck`)
4. Test (`bun test`)
5. Build (`bun run build`)

## Common Tasks

### Add a new route

1. Create handler in `src/routes/your-feature/handler.ts`
2. Create route file in `src/routes/your-feature/route.ts`
3. Register in `src/server.ts`
4. Add tests in `tests/your-feature.test.ts`

### Add a new CLI option

1. Add to `args` object in `src/start.ts`
2. Pass to `runServer()` function
3. Use in server logic
4. Update README.md

### Add error handling

1. Create error class in `src/lib/error.ts` (if needed)
2. Throw with context
3. Handle in route with `forwardError(c, error)`

### Modify rate limiting

Edit `src/lib/rate-limit.ts`:
- `DEFAULT_INTERVAL_MS` — Time between requests
- `DEFAULT_BURST` — Allowed burst size
- `MAX_BACKOFF_MS` — Maximum backoff duration

## Testing Checklist

Before committing changes:
- [ ] Run `bun test` — all tests pass
- [ ] Run `bun run typecheck` — no type errors
- [ ] Run `bun run lint` — no lint errors
- [ ] Update tests for new functionality
- [ ] Check for breaking changes in translation logic

## Debugging Tips

1. **Enable verbose logging:** `bun run dev -- --verbose`
2. **Show tokens:** Add `--show-token` flag
3. **Check debug info:** `bun run debug` or `bun run debug --json`
4. **Inspect state:** Import `state` from `~/lib/state` and log it
5. **Test rate limiter:** Use `resetAdaptiveRateLimiterForTest()` in tests
