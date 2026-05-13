#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { websocket } from "hono/bun"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { resolve } from "node:path"
import invariant from "tiny-invariant"

import {
  initAccounts,
  refreshCopilotToken,
  saveAccounts,
  scheduleQuotaRefresh,
} from "./lib/account-store"
import {
  type CodebuffAccount,
  type WindsurfAccount,
  getCodebuffAuthToken,
  getWindsurfApiKey,
} from "./lib/accounts"
import { loadGuard } from "./lib/guard"
import { ensurePaths } from "./lib/paths"
import {
  initializeProviderConnections,
  scheduleConnectionModelDiscovery,
} from "./lib/provider-connections"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { statsStore } from "./lib/stats-store"
import { loadUsers } from "./lib/users"
import {
  cacheModels,
  cacheVSCodeVersion,
  scheduleModelsRefresh,
} from "./lib/utils"
import { server } from "./server"
import { initializeProtocolAdapters } from "./services/protocols"

interface RunServerOptions {
  port: number
  verbose: boolean
  provider: "copilot" | "codebuff" | "windsurf"
  accountType: string
  manual: boolean
  githubToken?: string
  githubTokens?: string
  tokensFile?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  apiKey?: string
  adminPassword?: string
  codebuffBaseUrl?: string
  codebuffAuthToken?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks: boolean
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfAppVersion?: string
  windsurfLsVersion?: string
  windsurfModel?: string
  windsurfClientName?: string
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
    consola.error("Unhandled rejection:", reason)
  })

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.defaultProvider = options.provider
  state.provider = options.provider
  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
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

  state.codebuffBaseUrl = state.providerDefaults.codebuff.baseUrl
  state.codebuffAuthToken = state.providerDefaults.codebuff.authToken
  state.codebuffCliVersion = state.providerDefaults.codebuff.cliVersion
  state.codebuffAgentId = state.providerDefaults.codebuff.agentId
  state.codebuffModel = state.providerDefaults.codebuff.model
  state.codebuffCostMode = state.providerDefaults.codebuff.costMode
  state.codebuffAllowFallbacks = state.providerDefaults.codebuff.allowFallbacks

  state.providerDefaults.windsurf.apiKey = options.windsurfApiKey
  state.providerDefaults.windsurf.baseUrl =
    options.windsurfBaseUrl ?? state.providerDefaults.windsurf.baseUrl
  state.providerDefaults.windsurf.appVersion =
    options.windsurfAppVersion ?? state.providerDefaults.windsurf.appVersion
  state.providerDefaults.windsurf.lsVersion =
    options.windsurfLsVersion ?? state.providerDefaults.windsurf.lsVersion
  state.providerDefaults.windsurf.defaultModel =
    options.windsurfModel ?? state.providerDefaults.windsurf.defaultModel
  state.providerDefaults.windsurf.clientName =
    options.windsurfClientName ?? state.providerDefaults.windsurf.clientName

  if (options.provider === "codebuff") {
    consola.info(
      `Using codebuff defaults: ${state.providerDefaults.codebuff.baseUrl}`,
    )
  }
  if (options.provider === "windsurf") {
    consola.info(
      `Using windsurf defaults: ${state.providerDefaults.windsurf.baseUrl}`,
    )
  }

  state.manualApprove = options.manual
  state.showToken = options.showToken
  state.apiKey = options.apiKey
  state.legacyApiKey = options.apiKey
  state.adminPassword = options.adminPassword ?? options.apiKey

  if (state.apiKey) {
    consola.info("API key protection enabled")
    consola.warn(
      "⚠ Legacy API_KEY mode is deprecated. Use the admin panel to create per-user API keys for better security and auditability.",
    )
  }

  if (state.adminPassword) {
    consola.info("Admin login password is configured")
    await hashAdminPasswordInEnv(state.adminPassword)
  }

  // Scrub sensitive values from process.env to reduce exposure in memory
  for (const key of [
    "API_KEY",
    "ADMIN_PASSWORD",
    "GITHUB_TOKEN",
    "GITHUB_TOKENS",
  ]) {
    if (process.env[key]) {
      Reflect.deleteProperty(process.env, key)
    }
  }

  await ensurePaths()
  await cacheVSCodeVersion()

  {
    // Collect GitHub tokens from CLI options
    const allTokens: Array<string> = []
    if (options.githubTokens) {
      allTokens.push(
        ...options.githubTokens
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      )
    }
    if (options.tokensFile) {
      try {
        const fileContent = await fs.readFile(options.tokensFile, "utf8")
        allTokens.push(
          ...fileContent
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean),
        )
      } catch (err) {
        consola.warn("Failed to read tokens file:", err)
      }
    }
    if (options.githubToken && !allTokens.includes(options.githubToken)) {
      allTokens.unshift(options.githubToken)
    }

    if (allTokens.length > 0) {
      consola.info(`Using ${allTokens.length} provided GitHub token(s)`)
      // initAccounts will create account objects from tokens
      await initAccounts(allTokens)
    } else {
      // No tokens provided — load from disk, skip device flow
      // User can add accounts via Web UI later
      await initAccounts()
    }

    await ensureDirectProviderAccounts()

    // Load provider connections (generic OpenAI/Anthropic-compatible providers)
    await initializeProviderConnections()
    initializeProtocolAdapters()

    // Refresh Copilot tokens for copilot accounts
    for (const account of state.accounts) {
      if (account.provider !== "copilot") {
        continue
      }

      try {
        await refreshCopilotToken(account)
        // Sync legacy state.githubToken for backward compat services
        if (account === state.accounts[state.activeAccountIndex]) {
          state.githubToken =
            account.credentials?.githubToken ?? account.githubToken
        }
      } catch (err) {
        consola.warn(
          `Failed to get Copilot token for account "${account.label}":`,
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

    if (state.models) {
      consola.info(
        `Available models: \n${state.models.data.map((model) => `- ${model.id}`).join("\n")}`,
      )
    } else {
      consola.warn(
        "No models available — add a GitHub account via Web UI to get started",
      )
    }
  }

  // Load users
  await loadUsers()

  // Load guard blacklist
  await loadGuard()

  // Initialize stats store
  statsStore.init()

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(
      state.models,
      "No models available. Add a GitHub account via Web UI first, or provide a token via --github-token",
    )

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
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
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  if (state.apiKey) {
    consola.box(
      `🔐 API key protection is enabled.\nAdmin login: ${serverUrl}/admin/login\nAdmin password source: ADMIN_PASSWORD (or --admin-password). Fallback: API_KEY`,
    )
  } else {
    consola.box(
      `🌐 Admin Dashboard: ${serverUrl}/admin\n(Or add API key to require authentication)`,
    )
  }

  Bun.serve({
    fetch: server.fetch,
    websocket,
    port: options.port,
    idleTimeout: 0,
  })
}

export async function ensureDirectProviderAccounts(): Promise<void> {
  let changed = false
  changed = syncCodebuffDefaultAccount() || changed
  changed = syncWindsurfDefaultAccount() || changed

  if (changed) {
    await saveAccounts()
  }
}

function syncCodebuffDefaultAccount(): boolean {
  let changed = false
  const defaults = state.providerDefaults.codebuff
  const existingAccount = state.accounts.find(
    (account): account is CodebuffAccount =>
      isCodebuffManagedDefaultAccount(account)
      && getCodebuffAuthToken(account) === defaults.authToken,
  )

  if (existingAccount) {
    applyCodebuffDefaults(existingAccount)
    changed = true
  }

  if (
    defaults.authToken
    && !state.accounts.some(
      (account) =>
        account.provider === "codebuff"
        && getCodebuffAuthToken(account) === defaults.authToken,
    )
  ) {
    state.accounts.push(createCodebuffDefaultAccount())
    changed = true
  }

  return changed
}

function isCodebuffManagedDefaultAccount(account: {
  provider: string
  label: string
}): account is CodebuffAccount {
  return account.provider === "codebuff" && account.label === "codebuff-default"
}

function applyCodebuffDefaults(account: CodebuffAccount): void {
  const defaults = state.providerDefaults.codebuff
  account.settings = {
    ...account.settings,
    baseUrl: defaults.baseUrl,
    cliVersion: defaults.cliVersion,
    agentId: defaults.agentId,
    model: defaults.model,
    costMode: defaults.costMode,
    allowFallbacks: defaults.allowFallbacks,
  }
  account.codebuffBaseUrl = defaults.baseUrl
  account.codebuffCliVersion = defaults.cliVersion
  account.codebuffAgentId = defaults.agentId
  account.codebuffModel = defaults.model
  account.codebuffCostMode = defaults.costMode
  account.codebuffAllowFallbacks = defaults.allowFallbacks
}

function createCodebuffDefaultAccount() {
  const defaults = state.providerDefaults.codebuff
  return {
    id: randomUUID(),
    label: "codebuff-default",
    provider: "codebuff" as const,
    credentials: {
      authToken: defaults.authToken,
    },
    settings: {
      baseUrl: defaults.baseUrl,
      cliVersion: defaults.cliVersion,
      agentId: defaults.agentId,
      model: defaults.model,
      costMode: defaults.costMode,
      allowFallbacks: defaults.allowFallbacks,
    },
    codebuffAuthToken: defaults.authToken,
    codebuffBaseUrl: defaults.baseUrl,
    codebuffCliVersion: defaults.cliVersion,
    codebuffAgentId: defaults.agentId,
    codebuffModel: defaults.model,
    codebuffCostMode: defaults.costMode,
    codebuffAllowFallbacks: defaults.allowFallbacks,
    enabled: true,
    priority: 0,
    quotaState: "unknown" as const,
    createdAt: Date.now(),
  }
}

function syncWindsurfDefaultAccount(): boolean {
  let changed = false
  const defaults = state.providerDefaults.windsurf
  const existingAccount = state.accounts.find(
    (account): account is WindsurfAccount =>
      isWindsurfManagedDefaultAccount(account)
      && getWindsurfApiKey(account) === defaults.apiKey,
  )

  if (existingAccount) {
    applyWindsurfDefaults(existingAccount)
    changed = true
  }

  if (
    defaults.apiKey
    && !state.accounts.some(
      (account) =>
        account.provider === "windsurf"
        && getWindsurfApiKey(account) === defaults.apiKey,
    )
  ) {
    state.accounts.push(createWindsurfDefaultAccount())
    changed = true
  }

  return changed
}

function isWindsurfManagedDefaultAccount(account: {
  provider: string
  label: string
}): account is WindsurfAccount {
  return account.provider === "windsurf" && account.label === "windsurf-default"
}

function applyWindsurfDefaults(account: WindsurfAccount): void {
  const defaults = state.providerDefaults.windsurf
  account.settings = {
    ...account.settings,
    baseUrl: defaults.baseUrl,
    appVersion: defaults.appVersion,
    lsVersion: defaults.lsVersion,
    defaultModel: defaults.defaultModel,
    clientName: defaults.clientName,
  }
  account.windsurfBaseUrl = defaults.baseUrl
  account.windsurfAppVersion = defaults.appVersion
  account.windsurfLsVersion = defaults.lsVersion
  account.windsurfDefaultModel = defaults.defaultModel
  account.windsurfClientName = defaults.clientName
}

function createWindsurfDefaultAccount() {
  const defaults = state.providerDefaults.windsurf
  return {
    id: randomUUID(),
    label: "windsurf-default",
    provider: "windsurf" as const,
    credentials: {
      apiKey: defaults.apiKey,
    },
    settings: {
      baseUrl: defaults.baseUrl,
      appVersion: defaults.appVersion,
      lsVersion: defaults.lsVersion,
      defaultModel: defaults.defaultModel,
      clientName: defaults.clientName,
    },
    windsurfApiKey: defaults.apiKey,
    windsurfBaseUrl: defaults.baseUrl,
    windsurfAppVersion: defaults.appVersion,
    windsurfLsVersion: defaults.lsVersion,
    windsurfDefaultModel: defaults.defaultModel,
    windsurfClientName: defaults.clientName,
    enabled: true,
    priority: 0,
    quotaState: "unknown" as const,
    createdAt: Date.now(),
  }
}

function resolveProvider(
  provider?: string,
): "copilot" | "codebuff" | "windsurf" {
  if (provider === "codebuff") return "codebuff"
  if (provider === "windsurf") return "windsurf"
  return "copilot"
}

/**
 * If the admin password is plaintext (not sha256: prefixed),
 * hash it in-place and rewrite the .env file so the secret
 * is never stored in cleartext on disk after first boot.
 */
async function hashAdminPasswordInEnv(password: string): Promise<void> {
  if (password.startsWith("sha256:")) return

  const hashed = `sha256:${createHash("sha256").update(password).digest("hex")}`
  state.adminPassword = hashed

  // Attempt to rewrite .env — best-effort, non-fatal
  const envPath = resolve(process.cwd(), ".env")
  try {
    const content = await fs.readFile(envPath, "utf8")
    const updated = content.replace(
      /^ADMIN_PASSWORD=.+$/m,
      `ADMIN_PASSWORD=${hashed}`,
    )
    if (updated !== content) {
      await fs.writeFile(envPath, updated, "utf8")
      consola.success("ADMIN_PASSWORD in .env has been auto-hashed (sha256)")
    }
  } catch {
    // .env may not exist (password via CLI flag) — that's fine
  }
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
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "github-tokens": {
      type: "string",
      description:
        "Comma-separated list of GitHub tokens for multi-account load balancing",
    },
    "tokens-file": {
      type: "string",
      description:
        "Path to a file with one GitHub token per line (for multi-account setup)",
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
      default:
        process.env.WINDSURF_BASE_URL
        ?? "https://server.self-serve.windsurf.com",
      description: "Windsurf API base URL",
    },
    "windsurf-app-version": {
      type: "string",
      default: process.env.WINDSURF_APP_VERSION ?? "1.48.2",
      description: "Windsurf app version",
    },
    "windsurf-ls-version": {
      type: "string",
      default: process.env.WINDSURF_LS_VERSION ?? "2.0.1050",
      description: "Windsurf language-server version",
    },
    "windsurf-model": {
      type: "string",
      default: process.env.WINDSURF_MODEL ?? "swe-1-6-fast",
      description: "Windsurf default model",
    },
    "windsurf-client-name": {
      type: "string",
      default: process.env.WINDSURF_CLIENT_NAME ?? "windsurf-next",
      description: "Windsurf client name",
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
      githubToken: args["github-token"],
      githubTokens: args["github-tokens"] || process.env.GITHUB_TOKENS,
      tokensFile: args["tokens-file"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      apiKey: args["api-key"] || process.env.API_KEY,
      adminPassword: args["admin-password"] || process.env.ADMIN_PASSWORD,
      codebuffBaseUrl: args["codebuff-base-url"],
      codebuffAuthToken: args["codebuff-auth-token"],
      codebuffCliVersion: args["codebuff-cli-version"],
      codebuffAgentId: args["codebuff-agent-id"],
      codebuffModel: args["codebuff-model"],
      codebuffCostMode: args["codebuff-cost-mode"],
      codebuffAllowFallbacks: args["codebuff-allow-fallbacks"],
      windsurfApiKey: args["windsurf-api-key"],
      windsurfBaseUrl: args["windsurf-base-url"],
      windsurfAppVersion: args["windsurf-app-version"],
      windsurfLsVersion: args["windsurf-ls-version"],
      windsurfModel: args["windsurf-model"],
      windsurfClientName: args["windsurf-client-name"],
    })
  },
})
