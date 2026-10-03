import { copilotAccountCreation } from "~/services/providers/account-creation/copilot"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { copilotNativeAdapter } from "~/services/protocols/copilot-native"
import { copilotProviderRuntime } from "~/services/providers/copilot"

export function getCopilotModule(): ProviderModule {
  return {
    id: "copilot",
    descriptor: getProviderDescriptor("copilot"),
    accountCreation: copilotAccountCreation,
    adapter: copilotNativeAdapter,
    createRuntime: () => copilotProviderRuntime,
  }
}
