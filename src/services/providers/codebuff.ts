import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getCodebuffModelsForConnection } from "~/services/codebuff/get-models"

import type { ProviderRuntime } from "~/services/providers/runtime"

export const codebuffProviderRuntime: ProviderRuntime = {
  id: "codebuff",
  descriptor: getProviderDescriptor("codebuff"),
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  refreshModels(connection) {
    const models = getCodebuffModelsForConnection(connection)
    return Promise.resolve(models)
  },
  getFallbackModels(connection) {
    return getCodebuffModelsForConnection(connection)
  },
}
