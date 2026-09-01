import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  canonicalNativeModelId,
  getOAuthProjectId,
  isOAuthAccount,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { generateAntigravityStableSessionId } from "~/lib/routing"
import {
  getSensitiveWordMatcherFromEnv,
  obfuscateGeminiSystemInstruction,
} from "~/lib/sensitive-words"
import { isChatCompletionResponse } from "~/lib/utils"
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_DAILY_API_BASE_URL,
} from "~/services/oauth/antigravity"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"

import { buildAntigravityHeaders } from "./headers"
import {
  preResolveSignatures,
  translateOpenAiChatToAntigravity,
} from "./translate-request"
import {
  convertAntigravityNonStreamResponse,
  convertAntigravityStreamChunk,
  createAntigravityStreamState,
} from "./translate-response"

const ANTIGRAVITY_BASE_URLS = [
  ANTIGRAVITY_DAILY_API_BASE_URL,
  ANTIGRAVITY_API_BASE_URL,
]

function parseSseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return undefined
  }
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === "[DONE]") {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function* convertSseLine(
  line: string,
  model: string,
  state: ReturnType<typeof createAntigravityStreamState>,
): Generator<CopilotStreamEvent> {
  const event = parseSseJson(line)
  if (!event) return
  for (const openAiChunk of convertAntigravityStreamChunk(
    event,
    model,
    state,
  )) {
    yield { data: JSON.stringify(openAiChunk) }
  }
}

async function* translateAntigravitySseToOpenAi(
  response: Response,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  const stream = response.body
  if (!stream) {
    throw new Error("Antigravity stream body is empty")
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const state = createAntigravityStreamState(model)
  const maxReadChunkBytes = 64 * 1024

  while (true) {
    const readResult = (await reader.read()) as {
      done: boolean
      value?: Uint8Array
    }
    if (readResult.done) {
      break
    }
    if (!readResult.value) {
      continue
    }
    for (
      let offset = 0;
      offset < readResult.value.byteLength;
      offset += maxReadChunkBytes
    ) {
      const piece = readResult.value.subarray(
        offset,
        Math.min(offset + maxReadChunkBytes, readResult.value.byteLength),
      )
      buffer += decoder.decode(piece, { stream: true })
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        throw new Error("Antigravity SSE line exceeds the maximum size")
      }
      let lineStart = 0
      while (true) {
        const lineEnd = buffer.indexOf("\n", lineStart)
        if (lineEnd === -1) break
        const line = buffer.slice(lineStart, lineEnd)
        for (const output of convertSseLine(line, model, state)) yield output
        lineStart = lineEnd + 1
      }
      if (lineStart > 0) buffer = buffer.slice(lineStart)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) {
    for (const output of convertSseLine(buffer, model, state)) yield output
  }

  yield { data: "[DONE]" }
}

async function postAntigravityRequest(
  account: Account,
  accessToken: string,
  upstreamBody: ReturnType<typeof translateOpenAiChatToAntigravity>,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | undefined

  for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
    const settingsBase =
      isOAuthAccount(account) ? account.settings?.baseUrl : undefined
    const resolvedBase = (settingsBase ?? baseUrl).replace(/\/+$/, "")
    const path =
      stream ?
        `${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`
      : `${ANTIGRAVITY_API_VERSION}:generateContent`
    const url = `${resolvedBase}/${path}`

    try {
      const response = await fetchWithOAuthProxy(account, url, {
        method: "POST",
        headers: buildAntigravityHeaders(accessToken, stream),
        body: JSON.stringify(upstreamBody),
        signal,
      })
      if (response.ok) {
        return response
      }
      const body = await response.text().catch(() => "")
      if (response.status >= 500) {
        lastError = new HTTPError(
          "Antigravity upstream server error",
          response,
          body,
        )
        continue
      }
      throw new HTTPError(
        "Failed to create Antigravity chat completion",
        response,
        body,
      )
    } catch (error: unknown) {
      if (error instanceof HTTPError) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastError ?? new Error("Antigravity upstream request failed")
}

export async function createAntigravityChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  if (!isOAuthAccount(account) || account.provider !== "antigravity") {
    throw new Error("Antigravity chat requires an Antigravity OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(
      `Antigravity access token missing for account "${account.label}"`,
    )
  }

  const projectId = getOAuthProjectId(account)
  if (!projectId) {
    throw new Error(
      `Antigravity project_id missing for account "${account.label}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  // Pre-resolve cached thoughtSignatures for assistant messages in history.
  const signatureRegistry = await preResolveSignatures(model, payload.messages)
  const upstreamBody = translateOpenAiChatToAntigravity(
    { ...payload, model },
    projectId,
    signatureRegistry,
  )
  const stream = payload.stream === true

  // L1 Antigravity only: request.sessionId (CPA generateStableSessionID).
  // Do not reuse Codex Session_id / Claude session header formats here.
  // Priority: client headers → first-user content hash → omit.
  const forwarded = ctx?.forwardedHeaders
  const headerSession =
    forwarded?.["x-antigravity-session-id"]
    ?? forwarded?.["session_id"]
    ?? forwarded?.["session-id"]
  const sessionId =
    (typeof headerSession === "string" && headerSession.trim() ?
      headerSession.trim()
    : undefined)
    ?? resolveAntigravityStableSessionFromMessages(payload.messages)
  if (sessionId) {
    upstreamBody.request.sessionId = sessionId
  }

  // L1 Antigravity only: inject the top-level metadata the native IDE client
  // sends, so the request carries the same audit identity (CPA mirrors this).
  upstreamBody.userAgent = "antigravity"
  // image 模型使用 image_gen 请求类型，其余使用 agent
  const isImageModel = model.includes("image")
  upstreamBody.requestType = isImageModel ? "image_gen" : "agent"
  upstreamBody.requestId =
    isImageModel ?
      `image_gen/${Date.now()}/${randomUUID()}/12`
    : `agent-${randomUUID()}`

  // 删除 safetySettings：原生客户端不发送此字段
  delete upstreamBody.request.safetySettings

  // 敏感词混淆：在 systemInstruction 的文本中插入零宽空格
  // 通过 SENSITIVE_WORDS 环境变量配置，逗号分隔
  const matcher = getSensitiveWordMatcherFromEnv()
  if (matcher) {
    const obfuscated = obfuscateGeminiSystemInstruction(
      upstreamBody as unknown as Record<string, unknown>,
      matcher,
    )
    Object.assign(upstreamBody, obfuscated)
  }

  const response = await postAntigravityRequest(
    account,
    accessToken,
    upstreamBody,
    stream,
    signal,
  )

  if (stream) {
    return translateAntigravitySseToOpenAi(response, model)
  }

  const raw = (await response.json()) as Record<string, unknown>
  const body = convertAntigravityNonStreamResponse(raw, model)
  if (!isChatCompletionResponse(body)) {
    throw new Error(
      "Antigravity upstream returned invalid chat completion response",
    )
  }
  return body
}

/**
 * CPA-compatible stable session id from the first user message text.
 * Format: "-<positive-int64-decimal>" from sha256 of the text.
 */
function resolveAntigravityStableSessionFromMessages(
  messages: Array<Message> | undefined,
): string | undefined {
  if (!messages?.length) return undefined
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = extractOpenAiMessageText(message.content)
    if (text) return generateAntigravityStableSessionId(text)
  }
  return undefined
}

function extractOpenAiMessageText(content: Message["content"]): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  for (const part of content) {
    if (
      typeof part === "object"
      && "type" in part
      && part.type === "text"
      && "text" in part
      && typeof part.text === "string"
    ) {
      parts.push(part.text)
    }
  }
  return parts.join("").trim()
}
