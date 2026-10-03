import { codebuffAccountCreation } from "~/services/providers/account-creation/codebuff"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { codebuffNativeAdapter } from "~/services/protocols/codebuff-native"
import { codebuffProviderRuntime } from "~/services/providers/codebuff"

export function getCodebuffModule(): ProviderModule {
  return {
    id: "codebuff",
    descriptor: getProviderDescriptor("codebuff"),
    accountCreation: codebuffAccountCreation,
    adapter: codebuffNativeAdapter,
    createRuntime: () => codebuffProviderRuntime,
  }
}
