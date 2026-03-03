#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import fs from "node:fs/promises"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import {
  initAccounts,
  scheduleQuotaRefresh,
  refreshCopilotToken,
} from "./lib/accounts"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"
import { loadUsers } from "./lib/users"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
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

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.showToken = options.showToken
  state.apiKey = options.apiKey
  state.legacyApiKey = options.apiKey
  state.adminPassword = options.adminPassword ?? options.apiKey

  if (state.apiKey) {
    consola.info("API key protection enabled")
  }

  if (state.adminPassword) {
    consola.info("Admin login password is configured")
  }

  await ensurePaths()
  await cacheVSCodeVersion()

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
    // No tokens provided — load from disk or prompt device flow
    await setupGitHubToken()
    await initAccounts()
  }

  // Load users
  await loadUsers()

  // Refresh Copilot tokens for all accounts
  for (const account of state.accounts) {
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

  await cacheModels()

  if (state.models) {
    consola.info(
      `Available models: \n${state.models.data.map((model) => `- ${model.id}`).join("\n")}`,
    )
  } else {
    consola.warn(
      "No models available — add a GitHub account via Web UI to get started",
    )
  }

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
      `🔐 API key protection is enabled.\nAdmin login: ${serverUrl}/admin/login\nUsage dashboard: ${serverUrl}/usage (requires auth)\nAdmin password source: ADMIN_PASSWORD (or --admin-password). Fallback: API_KEY`,
    )
  } else {
    consola.box(
      `🌐 Local Usage Dashboard: ${serverUrl}/usage\n(Or add API key to require authentication)`,
    )
  }

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
  })
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
  },
  run({ args }) {
    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
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
    })
  },
})
