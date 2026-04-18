import { createCodebuffChatCompletions } from "~/services/codebuff/create-chat-completions"
import { getCodebuffModelsForAccount } from "~/services/codebuff/get-models"

import type { ProviderRuntime } from "./runtime"

export const codebuffProviderRuntime: ProviderRuntime = {
  id: "codebuff",
  descriptor: {
    id: "codebuff",
    name: "Codebuff",
    icon: "bot",
    authMode: "direct",
    features: ["cooldown"],
    accountFields: [
      {
        key: "authToken",
        type: "secret",
        labelKey: "accounts.provider.codebuff.fields.authToken",
        required: true,
      },
      {
        key: "baseUrl",
        type: "url",
        labelKey: "accounts.provider.codebuff.fields.baseUrl",
      },
      {
        key: "agentId",
        type: "text",
        labelKey: "accounts.provider.codebuff.fields.agentId",
      },
      {
        key: "model",
        type: "text",
        labelKey: "accounts.provider.codebuff.fields.model",
      },
      {
        key: "allowFallbacks",
        type: "checkbox",
        labelKey: "accounts.provider.codebuff.fields.allowFallbacks",
      },
    ],
  },
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  refreshModels(account) {
    const models = getCodebuffModelsForAccount(account)
    account.availableModels = models
    return Promise.resolve(models)
  },
  createChatCompletions(account, payload, signal) {
    return createCodebuffChatCompletions(
      account,
      {
        ...payload,
        model:
          payload.model.includes("/") ?
            payload.model.split("/").slice(1).join("/")
          : payload.model,
      },
      signal,
    )
  },
}
