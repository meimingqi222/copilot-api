import consola from "consola"

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
  normalizeResponsesStreamIds,
  shouldUseResponsesApi,
  supportsResponsesApi,
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
  translateToResponsesPayload,
} from "~/services/copilot/responses-api"
import {
  safeSseStream,
  detectOpenAIStreamError,
  detectResponsesStreamError,
} from "~/services/protocols/shared"

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

    const chatCompletionsBody = JSON.stringify(normalizedPayload)
    const responsesBody =
      useResponsesApi ?
        JSON.stringify(translateToResponsesPayload(normalizedPayload))
      : ""

    const headers: Record<string, string> = {
      ...copilotHeaders(account, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
    }

    if (ctx?.initiator) {
      headers["X-Initiator"] = ctx.initiator
    }

    let retryCount = 0
    const maxRetries = 3
    const maxDelayMs = 60_000

    let response = await fetch(
      `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`,
      {
        method: "POST",
        headers,
        body: useResponsesApi ? responsesBody : chatCompletionsBody,
        signal,
      },
    )

    while (!response.ok && response.status === 429 && retryCount < maxRetries) {
      const retryAfterRaw = Number.parseInt(
        response.headers.get("Retry-After") ?? "",
        10,
      )
      const baseDelayMs =
        Number.isNaN(retryAfterRaw) ?
          Math.pow(2, retryCount) * 1000
        : retryAfterRaw * 1000
      const delayMs = Math.min(baseDelayMs, maxDelayMs)

      consola.warn(
        `Copilot API rate limited, retry ${retryCount + 1}/${maxRetries} after ${delayMs}ms`,
      )

      if (signal?.aborted) {
        throw new HTTPError(
          "Request aborted",
          new Response("Aborted", { status: 499 }),
        )
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
      retryCount++

      response = await fetch(
        `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`,
        {
          method: "POST",
          headers,
          body: useResponsesApi ? responsesBody : chatCompletionsBody,
          signal,
        },
      )
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError(
        "Failed to create chat completions",
        response,
        errorBody,
      )
    }

    if (normalizedPayload.stream) {
      const stream = await safeSseStream(response, detectOpenAIStreamError)
      return {
        accountId: account.id,
        response:
          useResponsesApi ?
            (translateResponsesStreamToChatCompletions(
              stream as unknown as AsyncIterable<
                import("~/services/copilot/create-chat-completions").CopilotStreamEvent
              >,
              normalizedPayload.model,
            ) as AsyncIterable<
              import("~/services/copilot/create-chat-completions").CopilotStreamEvent
            >)
          : (stream as unknown as AsyncIterable<
              import("~/services/copilot/create-chat-completions").CopilotStreamEvent
            >),
      }
    }

    const responseBody = await response.json()
    return {
      accountId: account.id,
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

    const responsesBody = JSON.stringify({
      ...payload,
      model: normalizedModel,
    })

    const headers: Record<string, string> = {
      ...copilotHeaders(account, enableVision),
      "editor-version": `vscode/${state.vsCodeVersion}`,
    }
    if (ctx?.initiator) {
      headers["X-Initiator"] = ctx.initiator
    }
    const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
      method: "POST",
      headers,
      body: responsesBody,
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      throw new HTTPError("Failed to create responses", response, errorBody)
    }

    if (payload.stream) {
      return {
        accountId: account.id,
        response: normalizeResponsesStreamIds(
          (await safeSseStream(
            response,
            detectResponsesStreamError,
          )) as unknown as AsyncIterable<
            import("~/services/copilot/responses-api").CopilotStreamEventLike
          >,
        ),
      }
    }

    return {
      accountId: account.id,
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

    const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
      method: "POST",
      headers: copilotHeaders(account),
      body: JSON.stringify({
        ...payload,
        model: parseModelReference(payload.model).nativeModelId,
      }),
      signal,
    })

    if (!response.ok) {
      throw new HTTPError("Failed to create embeddings", response)
    }

    return {
      accountId: account.id,
      response:
        (await response.json()) as import("~/services/copilot/create-embeddings").EmbeddingResponse,
    }
  },
}
