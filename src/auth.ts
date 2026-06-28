#!/usr/bin/env node

import { defineCommand } from "citty"

import { initLogger, logger } from "~/lib/logger"

import { PATHS, ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  state.showToken = options.showToken

  await ensurePaths()
  initLogger({ verbose: options.verbose })
  if (options.verbose) {
    logger.info("Verbose logging enabled")
  }
  await setupGitHubToken({ force: true })
  logger.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
