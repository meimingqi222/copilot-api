/* eslint-disable require-atomic-updates */
import { events } from "fetch-event-stream"

import type { Account, AccountModel } from "~/lib/accounts"

import {
  refreshCopilotToken,
  refreshQuotaForAccount,
} from "~/lib/account-store"
import {
  parseModelReference,
  canonicalNativeModelId,
  getCopilotToken,
} from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getModelsForAccount } from "~/services/copilot/get-models"
import {
  shouldUseResponsesApi,
  supportsResponsesApi,
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
  translateToResponsesPayload,
} from "~/services/copilot/responses-api"
import { executeProviderRequestWithRetry } from "~/services/providers/execution"

import type { ProviderRuntime } from "./runtime"

function toAccountModels(account: Account): Array<AccountModel> {
  if (account.provider !== "copilot") {
    return []
  }
  const models = account.availableModels ?? []
  return models.map((model) => ({ ...model, provider: "copilot" }))
}

export const copilotProviderRuntime: ProviderRuntime = {
  id: "copilot",
  descriptor: {
    id: "copilot",
    name: "Copilot",
    icon: "github",
    authMode: "device_flow",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "native_messages",
      "embeddings",
      "device_flow",
      "model_discovery",
    ],
    accountFields: [],
  },
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(account) {
    if (account.provider !== "copilot") {
      return []
    }
    if (!getCopilotToken(account)) {
      return toAccountModels(account)
    }
    const models = await getModelsForAccount(account)
    const seen = new Set<string>()
    account.availableModels = models.data
      .filter((model) => {
        if (model.policy?.state !== "enabled") return false
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      .map((model) => ({
        id: canonicalNativeModelId(model.id),
        name: model.name,
        vendor: model.vendor,
        pickerEnabled: model.model_picker_enabled,
        pickerCategory: model.model_picker_category,
        supportedEndpoints: model.supported_endpoints ?? [],
        provider: "copilot",
      }))
    return toAccountModels(account)
  },
  async refreshQuota(account) {
    await refreshQuotaForAccount(account)
    return account.quotaInfo
  },
  async refreshAuth(account) {
    await refreshCopilotToken(account)
  },
  // eslint-disable-next-line max-params
  async createChatCompletions(account, payload, signal, ctx) {
    if (account.provider !== "copilot") {
      throw new Error(
        `Invalid provider for Copilot runtime: ${account.provider}`,
      )
    }
    if (!getCopilotToken(account)) {
      throw new Error("Copilot token not found")
    }

    const normalizedPayload = {
      ...payload,
      model: parseModelReference(payload.model).nativeModelId,
    }
    const useResponsesApi = shouldUseResponsesApi(
      normalizedPayload.model,
      account,
    )
    const enableVision =
      ctx?.enableVision
      ?? normalizedPayload.messages.some(
        (message) =>
          typeof message.content !== "string"
          && message.content?.some((content) => content.type === "image_url"),
      )

    const doRequest = async (requestAccount: Account) => {
      const headers: Record<string, string> = {
        ...copilotHeaders(requestAccount, enableVision),
        "editor-version": `vscode/${state.vsCodeVersion}`,
      }

      if (ctx?.initiator) {
        headers["X-Initiator"] = ctx.initiator
      }

      const response = await fetch(
        `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(
            useResponsesApi ?
              translateToResponsesPayload(normalizedPayload)
            : normalizedPayload,
          ),
          signal,
        },
      )

      if (response.status === 429) {
        const errorBody = await response.text().catch(() => "(unreadable)")
        throw new HTTPError(
          "Failed to create chat completions",
          response,
          errorBody,
        )
      }

      return response
    }

    const { account: usedAccount, result: response } =
      await executeProviderRequestWithRetry({
        account,
        model: normalizedPayload.model,
        signal,
        execute: doRequest,
      })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError(
        "Failed to create chat completions",
        response,
        errorBody,
      )
    }

    if (normalizedPayload.stream) {
      const stream = events(response) as unknown as AsyncIterable<
        import("~/services/copilot/create-chat-completions").CopilotStreamEvent
      >
      return {
        accountId: usedAccount.id,
        response:
          useResponsesApi ?
            (translateResponsesStreamToChatCompletions(
              stream,
              normalizedPayload.model,
            ) as AsyncIterable<
              import("~/services/copilot/create-chat-completions").CopilotStreamEvent
            >)
          : stream,
      }
    }

    const responseBody = await response.json()
    return {
      accountId: usedAccount.id,
      response:
        useResponsesApi ?
          translateResponsesToChatCompletion(
            responseBody as Parameters<
              typeof translateResponsesToChatCompletion
            >[0],
          )
        : (responseBody as import("~/services/copilot/create-chat-completions").ChatCompletionResponse),
    }
  },
  // eslint-disable-next-line max-params
  async createResponses(account, payload, signal, ctx) {
    if (account.provider !== "copilot") {
      throw new Error(
        `Invalid provider for Copilot runtime: ${account.provider}`,
      )
    }
    const normalizedModel = parseModelReference(payload.model).nativeModelId

    if (!supportsResponsesApi(normalizedModel, account)) {
      throw new Error("Copilot runtime createResponses expects native support")
    }

    if (!getCopilotToken(account)) {
      throw new Error("Copilot token not found")
    }

    const enableVision =
      ctx?.enableVision
      ?? (typeof payload.input === "string" ?
        false
      : payload.input.some(
          (item) =>
            "role" in item
            && Array.isArray(item.content)
            && item.content.some((content) => content.type === "input_image"),
        ))

    const doRequest = async (requestAccount: Account) => {
      const headers: Record<string, string> = {
        ...copilotHeaders(requestAccount, enableVision),
        "editor-version": `vscode/${state.vsCodeVersion}`,
      }
      if (ctx?.initiator) {
        headers["X-Initiator"] = ctx.initiator
      }
      const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...payload,
          model: normalizedModel,
        }),
        signal,
      })

      if (response.status === 429) {
        const errorBody = await response.text().catch(() => "(unreadable)")
        throw new HTTPError("Failed to create responses", response, errorBody)
      }

      return response
    }

    const { account: usedAccount, result: response } =
      await executeProviderRequestWithRetry({
        account,
        model: normalizedModel,
        signal,
        execute: doRequest,
      })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError("Failed to create responses", response, errorBody)
    }

    if (payload.stream) {
      return {
        accountId: usedAccount.id,
        response: events(response) as unknown as AsyncIterable<
          import("~/services/copilot/responses-api").CopilotStreamEventLike
        >,
      }
    }

    return {
      accountId: usedAccount.id,
      response:
        (await response.json()) as import("~/services/copilot/responses-api").ResponsesResponse,
    }
  },
  async createEmbeddings(account, payload, signal) {
    if (account.provider !== "copilot") {
      throw new Error(
        `Invalid provider for Copilot runtime: ${account.provider}`,
      )
    }
    if (!getCopilotToken(account)) {
      throw new Error("Copilot token not found")
    }

    const { account: usedAccount, result: response } =
      await executeProviderRequestWithRetry({
        account,
        model: payload.model,
        signal,
        execute: async (requestAccount) => {
          const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
            method: "POST",
            headers: copilotHeaders(requestAccount),
            body: JSON.stringify({
              ...payload,
              model: parseModelReference(payload.model).nativeModelId,
            }),
            signal,
          })

          if (response.status === 429) {
            throw new HTTPError("Failed to create embeddings", response)
          }

          return response
        },
      })

    if (!response.ok) {
      throw new HTTPError("Failed to create embeddings", response)
    }

    return {
      accountId: usedAccount.id,
      response:
        (await response.json()) as import("~/services/copilot/create-embeddings").EmbeddingResponse,
    }
  },
}
