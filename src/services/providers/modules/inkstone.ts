import { providerMetadata } from "~/lib/provider-descriptors/inkstone"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import { inkstoneAccountCreation } from "~/services/inkstone/account"
import { createInkstoneChat } from "~/services/inkstone/chat"
import { discoverInkstoneModels } from "~/services/inkstone/models"
import { fetchInkstoneQuota } from "~/services/inkstone/quota"
import type { ProtocolAdapter } from "~/services/protocols/types"
import type { ProviderModule } from "~/services/providers/module"

const { descriptor, protocol } = providerMetadata
const quota = { source: "poll" } as const
const adapter: ProtocolAdapter = {
  protocol,
  createChatCompletions: createInkstoneChat,
  discoverModels: ({ connection, signal }) =>
    discoverInkstoneModels(connection, signal),
  isModelCreditExempt: (connection, id) =>
    connection.models?.some(
      (model) => model.upstreamId === id && model.metadata?.isFree === true,
    ) ?? false,
}

export function getInkstoneModule(): ProviderModule {
  return {
    id: descriptor.id,
    descriptor,
    adapter,
    quota,
    accountCreation: inkstoneAccountCreation,
    discoverModels: discoverInkstoneModels,
    fetchQuota: fetchInkstoneQuota,
    createRuntime: () => ({
      id: descriptor.id,
      descriptor,
      adapter,
      quota,
      supports: (connection, feature) =>
        connection.protocol === protocol
        && descriptor.features.includes(feature),
      refreshModels: discoverInkstoneModels,
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchInkstoneQuota, signal, options),
    }),
  }
}
