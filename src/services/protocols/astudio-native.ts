import { HTTPError } from "~/lib/error"
import {
  performanceFetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { ASTUDIO_MODEL_ORIGIN } from "~/services/astudio/auth"
import { discoverStudioModels } from "~/services/astudio/catalog"
import { createResponsesNativeAdapter } from "~/services/protocols/responses-native"
import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import {
  connectionFetchInit,
  detectResponsesStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"

export const studioNativeAdapter = createResponsesNativeAdapter(
  "astudio-native",
  async ({ connection, credential }, payload, signal) => {
    if (!credential.value)
      throw new HTTPError(
        "Astron Studio model bearer is missing",
        new Response(null, { status: 401 }),
      )
    const response = await performanceFetch(
      `${ASTUDIO_MODEL_ORIGIN}/model-gateway/v1/responses`,
      connectionFetchInit(connection, {
        method: "POST",
        redirect: "error",
        signal,
        body: serializeUpstreamBody(payload),
        headers: {
          Authorization: `Bearer ${credential.value}`,
          "Content-Type": "application/json",
          Accept: payload.stream ? "text/event-stream" : "application/json",
        },
      }),
    )
    if (!response.ok)
      await handleUpstreamFailure(
        response,
        credential,
        "Astron Studio request failed",
        "astudio-native",
      )
    return payload.stream ?
        safeSseStream<CopilotStreamEventLike>(
          response,
          detectResponsesStreamError,
        )
      : ((await readUpstreamJson(response)) as ResponsesResponse)
  },
)

studioNativeAdapter.discoverModels = ({ connection, signal }) =>
  discoverStudioModels(connection, signal)
studioNativeAdapter.isModelCreditExempt = (connection, id) =>
  connection.models?.some(
    (m) => m.upstreamId === id && m.metadata?.free === true,
  ) ?? false
