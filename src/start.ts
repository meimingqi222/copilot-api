#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import { websocket } from "hono/bun"
import invariant from "tiny-invariant"

import { flushAllPersistentMaps } from "~/lib/cache/persistent-map"
import { initLogger, logger } from "~/lib/logger"

import {
  flushAccountsOnShutdown,
  initAccounts,
  refreshCopilotToken,
  scheduleQuotaRefresh,
} from "./lib/account-store"
import { hashAdminPasswordInEnv } from "./lib/admin-password"
import { loadGuard } from "./lib/guard"
import { ensurePaths } from "./lib/paths"
import { acquireServerLock, releaseServerLock } from "./lib/process-lock"
import {
  initializeProviderConnections,
  scheduleConnectionModelDiscovery,
} from "./lib/provider-connections"
import { initializeCredentialRefreshers } from "./lib/provider-connections/refresher-impls"
import { ensureDirectProviderAccounts } from "./lib/provider-defaults"
import { initProxyFromEnv } from "./lib/proxy"
import {
  loadAdminPasswordFromDb,
  saveAdminPasswordToDb,
} from "./lib/request-auth"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { statsStore } from "./lib/stats-store"
import { globalTimers } from "./lib/timer-registry"
import { loadUsers } from "./lib/users"
import {
  cacheModels,
  cacheVSCodeVersion,
  scheduleModelsRefresh,
} from "./lib/utils"
import { server } from "./server"
import { startMimoManager, stopMimoManager } from "./services/mimo/manager"
import { initializeProtocolAdapters } from "./services/protocols"

interface RunServerOptions {
  port: number
  verbose: boolean
  provider: "copilot" | "codebuff" | "windsurf"
  accountType: string
  manual: boolean
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  apiKey?: string
  adminPassword?: string
  /** fill-first (default, best cache) | round-robin */
  routingStrategy?: string
  /** Stick session → credential for prompt-cache hits (default true). */
  sessionAffinity?: boolean
  /** Codex-only identity confuse; requires affinity or fill-first. */
  identityConfuse?: boolean
  codebuffBaseUrl?: string
  codebuffAuthToken?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks: boolean
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfModel?: string
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason: unknown) => {
    if (
      reason instanceof DOMException
      && reason.name === "AbortError"
      && reason.message === "The connection was closed."
    ) {
      // Client disconnected, normal behavior
      return
    }
    logger.error("Unhandled rejection:", reason)
  })

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.defaultProvider = options.provider
  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    logger.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.providerDefaults.codebuff.baseUrl =
    options.codebuffBaseUrl ?? state.providerDefaults.codebuff.baseUrl
  state.providerDefaults.codebuff.authToken = options.codebuffAuthToken
  state.providerDefaults.codebuff.cliVersion =
    options.codebuffCliVersion ?? state.providerDefaults.codebuff.cliVersion
  state.providerDefaults.codebuff.agentId =
    options.codebuffAgentId ?? state.providerDefaults.codebuff.agentId
  state.providerDefaults.codebuff.model =
    options.codebuffModel ?? state.providerDefaults.codebuff.model
  state.providerDefaults.codebuff.costMode =
    options.codebuffCostMode ?? state.providerDefaults.codebuff.costMode
  state.providerDefaults.codebuff.allowFallbacks =
    options.codebuffAllowFallbacks

  state.providerDefaults.windsurf.apiKey = options.windsurfApiKey
  state.providerDefaults.windsurf.baseUrl =
    options.windsurfBaseUrl ?? state.providerDefaults.windsurf.baseUrl
  state.providerDefaults.windsurf.defaultModel =
    options.windsurfModel ?? state.providerDefaults.windsurf.defaultModel

  if (options.provider === "codebuff") {
    logger.info(
      `Using codebuff defaults: ${state.providerDefaults.codebuff.baseUrl}`,
    )
  }
  if (options.provider === "windsurf") {
    logger.info(
      `Using windsurf defaults: ${state.providerDefaults.windsurf.baseUrl}`,
    )
  }

  state.manualApprove = options.manual
  state.showToken = options.showToken
  state.legacyApiKey = options.apiKey
  state.adminPassword = options.adminPassword ?? options.apiKey

  // L0 routing defaults maximize prompt-cache utilization (fill-first + affinity).
  const strategyRaw = (options.routingStrategy ?? "fill-first")
    .trim()
    .toLowerCase()
  state.routing.strategy =
    strategyRaw === "round-robin" || strategyRaw === "rr" ?
      "round-robin"
    : "fill-first"
  if (options.sessionAffinity !== undefined) {
    state.routing.sessionAffinity = options.sessionAffinity
  }
  if (options.identityConfuse !== undefined) {
    state.routing.identityConfuse = options.identityConfuse
  }
  logger.info(
    `Cache routing (L0): strategy=${state.routing.strategy}, session-affinity=${state.routing.sessionAffinity}, ttlMs=${state.routing.sessionAffinityTtlMs}, identity-confuse=${state.routing.identityConfuse} (Codex L1 only)`,
  )

  if (state.legacyApiKey) {
    logger.info("API key protection enabled")
    logger.warn(
      "⚠ Legacy API_KEY mode is deprecated. Use the admin panel to create per-user API keys for better security and auditability.",
    )
  }

  if (state.adminPassword) {
    logger.info("Admin login password is configured")
    const plaintextPassword = state.adminPassword
    await hashAdminPasswordInEnv(plaintextPassword)
    saveAdminPasswordToDb(plaintextPassword)
    logger.info("Admin password synchronized to database")
  } else {
    loadAdminPasswordFromDb()
    if (state.adminPassword) {
      logger.info("Admin login password loaded from database")
    }
  }

  // Scrub sensitive values from process.env to reduce exposure in memory
  for (const key of ["API_KEY", "ADMIN_PASSWORD"]) {
    if (process.env[key]) {
      Reflect.deleteProperty(process.env, key)
    }
  }

  await ensurePaths()
  await acquireServerLock()
  initLogger({ verbose: options.verbose })
  if (options.verbose) {
    logger.info("Verbose logging enabled")
  }
  await cacheVSCodeVersion()

  // Load accounts from disk (configure via Web UI)
  await initAccounts()

  await ensureDirectProviderAccounts()

  // Load provider connections (generic OpenAI/Anthropic-compatible providers)
  await initializeProviderConnections()
  initializeProtocolAdapters()
  initializeCredentialRefreshers()

  // Refresh Copilot tokens for copilot accounts
  for (const account of state.accounts) {
    if (account.provider !== "copilot") {
      continue
    }

    try {
      await refreshCopilotToken(account)
    } catch (err) {
      logger.debug(
        `Failed to get Copilot token for account "${account.label}"`,
        err,
      )
    }
  }

  // Start background quota refresh
  scheduleQuotaRefresh()

  cacheModels()

  // Refresh models for all accounts and schedule periodic refresh
  scheduleModelsRefresh()
  scheduleConnectionModelDiscovery()

  // Start background MIMO manager
  startMimoManager()

  if (state.models) {
    logger.info(
      `Available models: \n${state.models.data.map((model) => `- ${model.id}`).join("\n")}`,
    )
  } else {
    logger.warn(
      "No models available — add a GitHub account via Web UI to get started",
    )
  }

  // Load users
  await loadUsers()

  // Load guard blacklist
  await loadGuard()

  // Initialize stats store
  statsStore.init()

  const { initModelsDevPricing } = await import("~/lib/models-dev")
  initModelsDevPricing()

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(
      state.models,
      "No models available. Add a GitHub account via Web UI first, or provide a token via --github-token",
    )

    const selectedModel = await logger.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await logger.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      logger.success("Copied Claude Code command to clipboard!")
    } catch {
      logger.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      logger.log(command)
    }
  }

  if (state.legacyApiKey) {
    logger.box(
      `🔐 API key protection is enabled.\nAdmin login: ${serverUrl}/admin/login\nAdmin password source: ADMIN_PASSWORD (or --admin-password). Fallback: API_KEY`,
    )
  } else {
    logger.box(
      `🌐 Admin Dashboard: ${serverUrl}/admin\n(Or add API key to require authentication)`,
    )
  }

  const bunServer = Bun.serve({
    fetch: server.fetch,
    websocket,
    port: options.port,
    hostname: process.env.HOST || undefined,
    idleTimeout: 0,
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("Shutting down...")
    try {
      await flushAllPersistentMaps()
      await flushAccountsOnShutdown()
    } catch (error) {
      logger.warn("Failed to flush state on shutdown", {
        error: (error as Error).message,
      })
    }
    globalTimers.clearAll()
    stopMimoManager()
    await releaseServerLock()
    void bunServer.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => {
    void shutdown()
  })
  process.on("SIGINT", () => {
    void shutdown()
  })
}

function resolveProvider(
  provider?: string,
): "copilot" | "codebuff" | "windsurf" {
  if (provider === "codebuff") return "codebuff"
  if (provider === "windsurf") return "windsurf"
  return "copilot"
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    provider: {
      type: "string",
      default: "copilot",
      description: "Provider to use (copilot, codebuff, windsurf)",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description: "(deprecated) Use the Web UI to configure accounts",
    },
    "github-tokens": {
      type: "string",
      description: "(deprecated) Use the Web UI to configure accounts",
    },
    "tokens-file": {
      type: "string",
      description: "(deprecated) Use the Web UI to configure accounts",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "api-key": {
      type: "string",
      description:
        "Require callers to provide this API key via Authorization: Bearer <key>",
    },
    "admin-password": {
      type: "string",
      description:
        "Password for /admin/login (falls back to API key if not set)",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "codebuff-base-url": {
      type: "string",
      default: process.env.CODEBUFF_BASE_URL ?? "https://www.codebuff.com",
      description: "Codebuff API base URL",
    },
    "codebuff-auth-token": {
      type: "string",
      default: process.env.CODEBUFF_AUTH_TOKEN,
      description: "Codebuff auth token",
    },
    "codebuff-cli-version": {
      type: "string",
      default: process.env.CODEBUFF_CLI_VERSION ?? "0.0.33",
      description: "Codebuff CLI version for User-Agent",
    },
    "codebuff-agent-id": {
      type: "string",
      default: process.env.CODEBUFF_AGENT_ID ?? "base",
      description: "Codebuff agent ID",
    },
    "codebuff-model": {
      type: "string",
      default: process.env.CODEBUFF_MODEL ?? "z-ai/glm-5.1",
      description: "Codebuff default model",
    },
    "codebuff-cost-mode": {
      type: "string",
      default: process.env.CODEBUFF_COST_MODE ?? "normal",
      description: "Codebuff cost mode",
    },
    "codebuff-allow-fallbacks": {
      type: "boolean",
      default: process.env.CODEBUFF_ALLOW_FALLBACKS !== "false",
      description: "Codebuff provider.allow_fallbacks",
    },
    "windsurf-api-key": {
      type: "string",
      default: process.env.WINDSURF_API_KEY,
      description: "Windsurf API key",
    },
    "windsurf-base-url": {
      type: "string",
      default: process.env.WINDSURF_BASE_URL ?? "https://server.codeium.com",
      description: "Windsurf API base URL",
    },
    "windsurf-model": {
      type: "string",
      default: process.env.WINDSURF_MODEL ?? "swe-1-6-fast",
      description: "Windsurf default model",
    },
    "routing-strategy": {
      type: "string",
      // fill-first maximizes cache hits: new sessions land on one credential.
      default: process.env.ROUTING_STRATEGY ?? "fill-first",
      description:
        "Credential selection: fill-first (default, best cache) or round-robin",
    },
    "session-affinity": {
      type: "boolean",
      default: process.env.SESSION_AFFINITY !== "false",
      description:
        "Stick sessions to the same credential for prompt-cache hits (default true)",
    },
    "identity-confuse": {
      type: "boolean",
      default: process.env.IDENTITY_CONFUSE === "true",
      description:
        "Codex L1 only: remap prompt_cache_key per account (default false; needs affinity or fill-first)",
    },
  },
  run({ args }) {
    const provider = resolveProvider(args.provider)
    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      provider,
      accountType: args["account-type"],
      manual: args.manual,
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      apiKey: args["api-key"] || process.env.API_KEY,
      adminPassword: args["admin-password"] || process.env.ADMIN_PASSWORD,
      routingStrategy: args["routing-strategy"],
      sessionAffinity: args["session-affinity"],
      identityConfuse: args["identity-confuse"],
      codebuffBaseUrl: args["codebuff-base-url"],
      codebuffAuthToken: args["codebuff-auth-token"],
      codebuffCliVersion: args["codebuff-cli-version"],
      codebuffAgentId: args["codebuff-agent-id"],
      codebuffModel: args["codebuff-model"],
      codebuffCostMode: args["codebuff-cost-mode"],
      codebuffAllowFallbacks: args["codebuff-allow-fallbacks"],
      windsurfApiKey: args["windsurf-api-key"],
      windsurfBaseUrl: args["windsurf-base-url"],
      windsurfModel: args["windsurf-model"],
    })
  },
})
