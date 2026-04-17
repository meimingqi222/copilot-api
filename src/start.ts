#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { websocket } from "hono/bun"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { resolve } from "node:path"
import invariant from "tiny-invariant"

import {
  initAccounts,
  scheduleQuotaRefresh,
  refreshCopilotToken,
} from "./lib/accounts"
import { loadGuard } from "./lib/guard"
import { ensurePaths } from "./lib/paths"
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

interface RunServerOptions {
  port: number
  verbose: boolean
  provider: "copilot" | "codebuff"
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
}

// eslint-disable-next-line max-lines-per-function, complexity
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

  state.provider = options.provider
  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  if (options.provider === "codebuff") {
    state.codebuffBaseUrl = options.codebuffBaseUrl ?? state.codebuffBaseUrl
    state.codebuffAuthToken = options.codebuffAuthToken
    state.codebuffCliVersion =
      options.codebuffCliVersion ?? state.codebuffCliVersion
    state.codebuffAgentId = options.codebuffAgentId ?? state.codebuffAgentId
    state.codebuffModel = options.codebuffModel ?? state.codebuffModel
    state.codebuffCostMode = options.codebuffCostMode ?? state.codebuffCostMode
    state.codebuffAllowFallbacks = options.codebuffAllowFallbacks
    consola.info(`Using codebuff defaults: ${state.codebuffBaseUrl}`)
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

    // Refresh Copilot tokens for copilot accounts
    for (const account of state.accounts) {
      if ((account.provider ?? "copilot") !== "copilot") {
        continue
      }

      try {
        await refreshCopilotToken(account)
        // Sync legacy state.githubToken for backward compat services
        if (account === state.accounts[state.activeAccountIndex]) {
          state.githubToken = account.githubToken
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
      description: "Provider to use (copilot, codebuff)",
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
  },
  run({ args }) {
    const provider =
      args.provider === "codebuff" ?
        ("codebuff" as const)
      : ("copilot" as const)
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
    })
  },
})
