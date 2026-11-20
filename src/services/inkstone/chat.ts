import { HTTPError, LocalPayloadUnsupportedError } from "~/lib/error"
import { isRecord } from "~/lib/json-shape"
import { readResponseBytes } from "~/lib/request-body"
import {
  performanceFetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { INKSTONE_API } from "~/services/inkstone/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import {
  connectionFetchInit,
  detectOpenAIStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import type {
  AdapterChatResult,
  AdapterParams,
} from "~/services/protocols/types"

const MiB = 1024 * 1024
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
])
const unsupportedExtension = /\.(?:svgz?|tiff?|hei[cf]|avif|ico)$/i

function shapeRefusal(why: string): LocalPayloadUnsupportedError {
  return new LocalPayloadUnsupportedError(
    `InkStone: extra inputs are not permitted: ${why}`,
  )
}

function inlineBytes(url: string): number {
  const inline = /^data:([^;,]+)(;base64)?,/i.exec(url)
  if (!inline) {
    if (unsupportedExtension.test(url.split(/[?#]/, 1)[0] ?? ""))
      throw shapeRefusal("this picture format is not accepted")
    return 0 // URL references are not downloaded by the proxy.
  }
  if (!imageTypes.has(inline[1]?.trim().toLowerCase() ?? ""))
    throw shapeRefusal("this picture format is not accepted")
  if (!inline[2]) return 0
  const chars = url.slice(inline[0].length).replace(/\s/g, "")
  const padding =
    chars.endsWith("==") ? 2
    : chars.endsWith("=") ? 1
    : 0
  return Math.max(0, Math.floor((chars.length * 3) / 4) - padding)
}

function rewriteChat(payload: ChatCompletionsPayload) {
  const {
    reasoning: _reasoning,
    reasoning_effort: _reasoningEffort,
    thinking: _thinking,
    output_config,
    ...rest
  } = payload as ChatCompletionsPayload & Record<string, unknown>
  const { effort: _effort, ...output } =
    isRecord(output_config) ? output_config : {}
  let count = 0
  let bytes = 0
  const messages = payload.messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    const content = message.content.map((part) => {
      if (part.type !== "image_url" || !isRecord(part.image_url)) return part
      count += 1
      if (count > 8) throw shapeRefusal("a request can carry at most 8 images")
      if (typeof part.image_url.url === "string") {
        const size = inlineBytes(part.image_url.url)
        if (size > 10 * MiB)
          throw shapeRefusal("each image can be at most 10 MiB")
        bytes += size
        if (bytes > 40 * MiB)
          throw shapeRefusal("total image size can be at most 40 MiB")
      }
      return part.image_url.detail === undefined ?
          { ...part, image_url: { ...part.image_url, detail: "auto" } }
        : part
    })
    return { ...message, content }
  })
  return {
    ...rest,
    messages,
    ...(isRecord(output_config)
      && Object.keys(output).length > 0 && { output_config: output }),
  }
}

function mediaError(body: string): LocalPayloadUnsupportedError | undefined {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined
  const nested = isRecord(data.error) ? data.error : {}
  const errorCode = data.code ?? nested.code
  if (errorCode === "media_fetch_failed")
    return shapeRefusal("InkStone could not fetch a linked picture")
  if (errorCode === "invalid_media" || errorCode === "unsupported_media_type")
    return shapeRefusal("InkStone rejected a picture in this request")
}

export async function createInkstoneChat({
  connection,
  credential,
  target,
  payload,
  signal,
}: AdapterParams<ChatCompletionsPayload>): Promise<AdapterChatResult> {
  if (!credential.value)
    throw shapeRefusal("this account has no Token Plan API key")
  const body = serializeUpstreamBody({
    ...rewriteChat(payload),
    model: target.upstreamModelId,
  })
  const response = await performanceFetch(
    `${INKSTONE_API}/chat/completions`,
    connectionFetchInit(connection, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.value}`,
        "content-type": "application/json",
        accept: payload.stream ? "text/event-stream" : "application/json",
      },
      body,
      signal,
      redirect: "error",
    }),
  )
  if (!response.ok) {
    const errorBody = await readResponseBytes(response, 1024 * 1024)
      .then((bytes) => new TextDecoder().decode(bytes))
      .catch(() => "")
    signal?.throwIfAborted()
    const media =
      (response.status === 400 || response.status === 502)
      && mediaError(errorBody)
    if (media) throw media
    throw new HTTPError("InkStone Chat Completions failed", response, errorBody)
  }
  if (payload.stream) {
    const events = await safeSseStream<CopilotStreamEvent>(
      response,
      (event) => mediaError(event.data ?? "") ?? detectOpenAIStreamError(event),
    )
    return { credentialId: credential.id, response: events }
  }
  const result = (await readUpstreamJson(response)) as ChatCompletionResponse
  return { credentialId: credential.id, response: result }
}
