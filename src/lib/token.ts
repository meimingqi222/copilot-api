import consola from "consola"
import fs from "node:fs/promises"

import { getActiveAccount } from "~/lib/account-selection"
import { refreshCopilotToken } from "~/lib/account-store"
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
  consola.debug("GitHub Copilot Token fetched successfully!")
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
        consola.info("GitHub token:", githubToken)
      }
      await logUser(githubToken)

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser(token)
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser(githubToken: string) {
  const user = await getGitHubUser(githubToken)
  consola.info(`Logged in as ${user.login}`)
}
