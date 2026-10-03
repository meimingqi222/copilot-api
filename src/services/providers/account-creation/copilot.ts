import { logger } from "~/lib/logger"
import { getDeviceCode } from "~/services/github/get-device-code"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"

export const copilotAccountCreation: ProviderAccountCreation = {
  async prepare({ label, registerDeviceFlow }) {
    let flow: Awaited<ReturnType<typeof getDeviceCode>>
    try {
      flow = await getDeviceCode()
    } catch (error) {
      logger.error("Failed to initiate GitHub device flow:", error)
      return {
        error: "Failed to initiate GitHub device flow.",
        status: 502,
      }
    }
    registerDeviceFlow(flow, label)
    return {
      response: {
        flowId: flow.device_code,
        status: "pending_auth",
        deviceCode: flow.device_code,
        userCode: flow.user_code,
        verificationUri: flow.verification_uri,
        expiresIn: flow.expires_in,
        interval: flow.interval,
      },
    }
  },
}
