import type { Context } from "hono"

import type {
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { ResponsesCompactPayload } from "~/services/responses/compact"

import { HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import { patchRequestLog } from "~/lib/request-log"
import { resolveTranscriptScopeId } from "~/lib/request-scope"
import {
  parseThinkingModel,
  thinkingConfigToResponsesEffort,
} from "~/lib/thinking"
import { identityFromAdmission } from "~/lib/usage"
import { applyUsageIdentity } from "~/lib/usage"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"
import { dispatchResponses } from "~/services/dispatch/responses"
import { collectResponsesFromEventStream } from "~/services/responses/sse-collector"

import {
  collectForwardedSessionHeaders,
  isNonStreaming,
  recordResponsesUsage,
} from "./handler"

/**
 * `POST /responses/compact`（及 `/v1/responses/compact`）：服务端上下文压缩。
 *
 * 客户端把历史发给上游的 compact 端口，上游返回压缩摘要
 * （`object: "response.compaction"`），由客户端替换本地历史。
 * 一元调用：带 `stream: true` 直接 400（对齐 CPA 与上游行为）。
 *
 * 调度走与 `/responses` 同一套 failover，只是候选池预过滤到
 * 原生支持 compact 的协议（admission `compact: true`），且执行期强制
 * HTTP（`ctx.compact` + `forceUpstreamHttp`，compact 没有 WS 形态）。
 */
export async function handleResponsesCompact(c: Context) {
  const signal = c.req.raw.signal
  const raw = await readJsonBody<ResponsesCompactPayload>(c.req.raw)
  if (!raw || typeof raw.model !== "string" || !raw.model.trim()) {
    throw new HTTPError(
      "Compaction request is missing model",
      new Response("Bad Request", { status: 400 }),
    )
  }
  if (raw.stream === true) {
    throw new HTTPError(
      "The compact endpoint is unary-only; stream must be false",
      new Response("Bad Request", { status: 400 }),
    )
  }

  const parsedThinkingModel = parseThinkingModel(raw.model)
  const suffixEffort =
    parsedThinkingModel.config ?
      thinkingConfigToResponsesEffort(parsedThinkingModel.config)
    : undefined
  const effectiveModel =
    parsedThinkingModel.config ? parsedThinkingModel.model : raw.model
  // dispatch 复用 responses 通道：payload 形态与 ResponsesPayload 兼容。
  const effectivePayload = {
    ...raw,
    model: effectiveModel,
    stream: false,
    ...(parsedThinkingModel.config && {
      reasoning: suffixEffort ? { effort: suffixEffort } : undefined,
    }),
  } as unknown as ResponsesPayload

  const forwardedHeaders = collectForwardedSessionHeaders(c)
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: effectiveModel,
    endpoint: "responses",
    stream: false,
    inferredInitiator: inferInitiatorFromResponsesPayload(effectivePayload),
    messageContent: extractMessageContentFromResponsesPayload(effectivePayload),
    sessionHeaders: forwardedHeaders,
    sessionPayload: effectivePayload,
    compact: true,
  })

  const start = Date.now()
  const result = await dispatchResponses(
    effectivePayload,
    admission,
    signal,
    c,
    {
      initiator: admission.initiator,
      forwardedHeaders,
      transcriptScopeId: resolveTranscriptScopeId(c),
      compact: true,
      forceUpstreamHttp: true,
    },
  )

  // compact 上游都是一元返回；防御性地收集万一流式回来的结果。
  const response: ResponsesResponse =
    isNonStreaming(result.response) ?
      result.response
    : await collectResponsesFromEventStream(result.response, effectiveModel)
  applyUsageIdentity(c, result.identity ?? identityFromAdmission(admission))
  c.set("model", effectiveModel)
  patchRequestLog(c, { streaming: false })

  const elapsed = Date.now() - start
  const completionTokens = response.usage?.output_tokens ?? 0
  const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
  recordResponsesUsage({
    c,
    accountId: result.accountId,
    response,
    tps,
    streaming: false,
  })
  patchRequestLog(c, {
    outcome: "success",
    outputObserved: true,
    protocolTerminal: `response.${response.status ?? "completed"}`,
  })
  return c.json(response)
}
