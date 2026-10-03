import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { mimoNativeAdapter } from "~/services/protocols/mimo-native"
import { mimoProviderRuntime } from "~/services/providers/mimo"

export function getMimoModule(): ProviderModule {
  return {
    id: "mimo-aistudio",
    descriptor: getProviderDescriptor("mimo-aistudio"),
    adapter: mimoNativeAdapter,
    createRuntime: () => mimoProviderRuntime,
  }
}
