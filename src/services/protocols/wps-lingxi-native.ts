import { createHash, randomUUID } from "node:crypto"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import { resolveTranscriptScopeId } from "~/lib/request-scope"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import { aggregateSseToResponse } from "~/services/protocols/sse-aggregate"
import type { AdapterParams, ProtocolAdapter } from "~/services/protocols/types"
import {
  credentialClient,
  identifier,
  LingxiClient,
  LingxiError,
  record,
  WPS_PATHS,
} from "~/services/wps-lingxi/client"
import { coworkWebStream, webPrompt } from "~/services/wps-lingxi/cowork-web"
import {
  discoverLingxiModels,
  isLingxiModel,
} from "~/services/wps-lingxi/models-quota"
import { buildLingxiRequest } from "~/services/wps-lingxi/request"
import { lingxiSse } from "~/services/wps-lingxi/stream"

type ChatParams = AdapterParams<ChatCompletionsPayload>

interface Run {
  sessionId: string
  runId: string
  createdAt: number
}

const HOUR = 3_600_000
const runs = new Map<string, Run>()

function runKey(
  params: ChatParams,
  origin: string,
  model: string,
): string | undefined {
  const { ctx, payload, connection, credential } = params
  const scope =
    ctx?.transcriptScopeId ?? (ctx?.c && resolveTranscriptScopeId(ctx.c))
  if (!scope) return undefined
  const extensions = record(payload)
  const thread = [
    ctx?.executionSessionId,
    record(extensions.client_metadata).thread_id,
    record(extensions.metadata).thread_id,
    extensions.thread_id,
    extensions.conversation_id,
  ].find(
    (value): value is string =>
      typeof value === "string" && value.length <= 512 && Boolean(value.trim()),
  )
  if (!thread) return undefined
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        thread.trim(),
        connection.id,
        credential.id,
        credential.value,
        origin,
        getConnectionProxyUrl(connection),
        model,
      ]),
    )
    .digest("hex")
}

async function createRun(
  client: LingxiClient,
  model: string,
  title: string,
): Promise<Run> {
  const sessionId = await client.session()
  const data = await client.json(WPS_PATHS.run, {
    client_request_id: randomUUID(),
    session_id: sessionId,
    model_provider: "lingxi",
    model_id: model,
    agent_input: {
      text: title,
      files: [],
      file_ids: [],
      expect_model: model,
      refs: [],
      permission_mode: "default",
      current_mode: "agent",
      browser_plugin_enabled: false,
    },
  })
  const runId = identifier(data.run_id)
  if (!runId) throw new LingxiError(502, "missing_run_id")
  return { sessionId, runId, createdAt: Date.now() }
}

async function ensureRun(
  client: LingxiClient,
  key: string | undefined,
  model: string,
  title: string,
): Promise<Run> {
  const existing = key ? runs.get(key) : undefined
  if (existing && Date.now() - existing.createdAt < HOUR) return existing
  const run = await createRun(client, model, title)
  if (key) {
    runs.delete(key)
    runs.set(key, run)
    const first = runs.keys().next().value
    if (runs.size > 256 && first !== undefined) runs.delete(first)
  }
  return run
}

function userTitle(messages: ChatCompletionsPayload["messages"]): string {
  const last = messages.findLast((message) => message.role === "user")?.content
  const text =
    typeof last === "string" ? last : (
      last
        ?.flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
    )
  return text?.trim().slice(0, 60) || "灵犀会话"
}

async function peek(
  stream: AsyncGenerator<CopilotStreamEvent>,
): Promise<AsyncIterable<CopilotStreamEvent>> {
  const first = await stream.next()
  return {
    [Symbol.asyncIterator]() {
      let pending = true
      return {
        next() {
          if (!pending) return stream.next()
          pending = false
          return Promise.resolve(first)
        },
        return: () => stream.return(undefined),
      }
    },
  }
}

async function send(
  params: ChatParams,
  client: LingxiClient,
  model: string,
  body: Record<string, unknown>,
): Promise<AsyncIterable<CopilotStreamEvent>> {
  const key = runKey(params, client.origin, model)
  const title = userTitle(params.payload.messages)
  let run = await ensureRun(client, key, model, title)
  const request = async () =>
    peek(lingxiSse(await client.chat(run, body), model))
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (error) {
      if (!(error instanceof LingxiError)) throw error
      if (
        key
        && (error.staleRun || error.reason === "PermissionDenied")
        && runs.get(key) === run
      )
        runs.delete(key)
      if (!error.staleRun || attempt > 0) throw error
      params.signal?.throwIfAborted()
      run = await ensureRun(client, key, model, title)
    }
  }
}

export const wpsLingxiNativeAdapter: ProtocolAdapter = {
  protocol: "wps-lingxi-native",
  discoverModels: ({ connection, credential, signal }) =>
    discoverLingxiModels(connection, signal, credential),
  async createChatCompletions(params) {
    const { target, signal, connection, credential, payload, ctx } = params
    const model = target.upstreamModelId.trim()
    if (!isLingxiModel(model))
      throw new LocalPayloadUnsupportedError(
        "WPS Lingxi needs an inference model, not a plan or automatic model selection",
      )
    const body = buildLingxiRequest(payload, model)
    const timeout = AbortSignal.timeout(240_000)
    const upstreamSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const proxyUrl = getConnectionProxyUrl(connection)
    const client = credentialClient(credential, {
      signal: upstreamSignal,
      proxyUrl,
    })
    let stream
    try {
      stream = await send(params, client, model, body)
    } catch (error) {
      if (
        !(error instanceof LingxiError)
        || error.reason !== "PermissionDenied"
      )
        throw error
      const prompt = webPrompt(payload)
      if (!prompt || Buffer.byteLength(prompt) > 320 * 1024) throw error
      stream = await peek(
        lingxiSse(
          await coworkWebStream({
            client,
            signal: upstreamSignal,
            proxyUrl,
            prompt,
            model,
            payload,
          }),
          model,
        ),
      )
    }
    if (payload.stream || ctx?.preferStreamingResponse)
      return { credentialId: credential.id, response: stream }
    return {
      credentialId: credential.id,
      response: await aggregateSseToResponse(stream, model),
    }
  },
}
