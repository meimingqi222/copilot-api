import fs from "node:fs/promises"

import { getFirstAvailableAccountManagedConnection } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { assertWritableDataPath, PATHS } from "~/lib/paths"
import { refreshCopilotTokenForConnection } from "~/services/copilot/token-refresh"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) => {
  assertWritableDataPath(PATHS.GITHUB_TOKEN_PATH)
  return fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)
}

/**
 * Refresh the Copilot token for the active account-managed connection.
 * Phase 1.7:直接用 connection 原生刷新,不再经由 getActiveAccount() →
 * Account 快照 → refreshCopilotToken(account) 桥接反查 connection。
 */
export const setupCopilotToken = async () => {
  const connection = getFirstAvailableAccountManagedConnection()
  if (!connection) {
    throw new HTTPError(
      "No available accounts (all disabled or no accounts configured)",
      new Response("Service Unavailable", { status: 503 }),
    )
  }
  await refreshCopilotTokenForConnection(connection)
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
