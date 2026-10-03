import { createCodebuddyAccountCreation } from "~/services/providers/account-creation/codebuddy"
import { scheduleCodebuddyRefresh } from "~/services/codebuddy/token-refresh"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"
import { codebuddyCnProviderRuntime } from "~/services/providers/codebuddy"
import { createCodebuddyStrategy } from "~/services/providers/modules/codebuddy"

const codebuddyCnStrategy = createCodebuddyStrategy("codebuddy-cn")

export function getCodebuddyCnModule(): ProviderModule {
  return {
    id: "codebuddy-cn",
    descriptor: getProviderDescriptor("codebuddy-cn"),
    accountCreation: createCodebuddyAccountCreation("codebuddy-cn"),
    afterAuthentication: scheduleCodebuddyRefresh,
    adapter: codebuddyNativeAdapter,
    createRuntime: () => codebuddyCnProviderRuntime,
    oauth: codebuddyCnStrategy,
  }
}
