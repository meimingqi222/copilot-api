import fs from "node:fs/promises"

import { getActiveAccount } from "~/lib/account-selection"
import { refreshCopilotToken } from "~/lib/account-store"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

/**
 * Refresh the Copilot token for the active account.
 * Delegates to accounts.ts which handles per-account token refresh + scheduling.
 */
export const setupCopilotToken = async () => {
  const account = getActiveAccount()
  await refreshCopilotToken(account)
  logger.debug("GitHub Copilot Token fetched successfully!")
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      if (state.showToken) {
        logger.info("GitHub token:", githubToken)
      }
      await logUser(githubToken)

      return
    }

    logger.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    logger.debug("Device code response:", response)

    logger.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)

    if (state.showToken) {
      logger.info("GitHub token:", token)
    }
    await logUser(token)
  } catch (error) {
    if (error instanceof HTTPError) {
      logger.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    logger.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser(githubToken: string) {
  const user = await getGitHubUser(githubToken)
  logger.info(`Logged in as ${user.login}`)
}
