/**
 * Gemini (Code Assist) Native Protocol Adapter。
 *
 * Gemini CLI 的订阅流量走 Google 的 Code Assist 后端
 * （`cloudcode-pa.googleapis.com`）：请求是 Gemini 自己的 generateContent
 * 请求，包进它的信封
 *
 *   { model, project, request, user_prompt_id }
 *
 * POST 到 `/v1internal:generateContent` 或 `/v1internal:streamGenerateContent`
 * （流式加 `?alt=sse`），回复是 SSE 行，每行 `{response: <gemini chunk>}`
 * 或 `{error: {message}}`。本 adapter 负责包信封、拆外层、把内层 Gemini
 * 事件原样交给上层（gemini 协议 codec 已在别处）。
 */

import type { ProviderConnection } from "~/lib/provider-connections"
import { HTTPError } from "~/lib/error"
import { getCredentialContextString } from "~/lib/provider-connections"
import {
  GEMINI_CODE_ASSIST_BASE,
  geminiUserAgent,
} from "~/services/oauth/gemini"
import type { GeminiStreamEvent } from "~/services/protocols/gemini/types"

import type { AdapterGeminiResult, ProtocolAdapter } from "./types"

function randomId(): string {
  return Math.random().toString(36).slice(2, 14)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** 把 SSE 的 `data:` 行拆出来，去掉 `{response}` 外层，产出内层 Gemini 事件。 */
async function* unwrapCodeAssistStream(
  response: Response,
): AsyncGenerator<GeminiStreamEvent> {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ""
  const handle = (raw: string): GeminiStreamEvent | null => {
    const line = raw.trim()
    if (!line.startsWith("data:")) return null
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return null
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return null
    }
    const error = asRecord(parsed.error)
    if (error && typeof error.message === "string") {
      throw new HTTPError(
        error.message,
        new Response(null, { status: 502 }),
        payload,
      )
    }
    const inner = parsed.response ?? parsed
    return { data: JSON.stringify(inner) }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const event = handle(line)
      if (event) yield event
    }
  }
  const tail = handle(buffer)
  if (tail) yield tail
}

function projectOf(connection: ProviderConnection): string {
  const project = getCredentialContextString(connection, "projectId")
  if (!project) {
    throw new HTTPError(
      "Gemini account is missing its Code Assist project — sign in again",
      new Response(null, { status: 401 }),
      "",
    )
  }
  return project
}

export const geminiNativeAdapter: ProtocolAdapter = {
  protocol: "gemini-native",

  async createGeminiGenerateContent({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    const stream = payload.stream === true
    const method = stream ? "streamGenerateContent" : "generateContent"
    const { model: _model, stream: _stream, ...request } = payload
    const envelope = {
      model: target.upstreamModelId,
      project: projectOf(connection),
      request,
      user_prompt_id: randomId(),
    }
    const url = `${GEMINI_CODE_ASSIST_BASE}/v1internal:${method}${stream ? "?alt=sse" : ""}`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.value}`,
        "content-type": "application/json",
        "user-agent": geminiUserAgent(),
      },
      body: JSON.stringify(envelope),
      signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new HTTPError(
        `Code Assist ${method} failed (${response.status})`,
        new Response(body || response.statusText, { status: response.status }),
        body,
      )
    }
    if (stream) {
      return {
        credentialId: credential.id,
        response: unwrapCodeAssistStream(response),
      } satisfies AdapterGeminiResult
    }
    const body = (await response.json()) as Record<string, unknown>
    const inner = asRecord(body.response) ?? body
    return {
      credentialId: credential.id,
      response: inner as never,
    } satisfies AdapterGeminiResult
  },
}
