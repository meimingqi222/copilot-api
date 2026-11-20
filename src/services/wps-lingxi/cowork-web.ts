import { ProxyAgent, WebSocket } from "undici"

import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import {
  envelopeFailure,
  LingxiError,
  record,
  type LingxiClient,
  WPS_PATHS,
  WPS_UA,
} from "~/services/wps-lingxi/client"

export function webPrompt(payload: ChatCompletionsPayload): string | undefined {
  if (
    payload.tools?.length
    || (payload.tool_choice
      && !["auto", "none"].includes(String(payload.tool_choice)))
  )
    return undefined
  const lines: Array<string> = []
  for (const message of payload.messages) {
    if (
      message.role === "tool"
      || message.tool_calls?.length
      || message.images?.length
    )
      return undefined
    const content = message.content
    let text = typeof content === "string" ? content : ""
    if (Array.isArray(content)) {
      if (content.some((part) => part.type !== "text")) return undefined
      text = content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
    }
    if (text.trim()) lines.push(`${message.role}: ${text}`)
  }
  return lines.join("\n\n") || undefined
}

interface WebOptions {
  client: LingxiClient
  signal: AbortSignal
  proxyUrl?: string
  prompt: string
  model: string
  payload: ChatCompletionsPayload
}

export async function coworkWebStream(
  options: WebOptions,
): Promise<ReadableStream<Uint8Array>> {
  const id = await options.client.session("cowork_web")
  const url = new URL(options.client.origin)
  url.protocol = "wss:"
  url.pathname = `${WPS_PATHS.session}/${encodeURIComponent(id)}/sandbox/completions/ws`
  options.signal.throwIfAborted()
  const { client, model, payload, prompt, signal, proxyUrl } = options
  const proxy = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const encoder = new TextEncoder()
  let ws: WebSocket | undefined
  let closed = false
  let abort = () => {}
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener("abort", abort)
    ws?.close()
    void proxy?.destroy().catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const fail = (error: unknown) => {
          if (closed) return
          controller.error(error)
          close()
        }
        const emit = (value: Record<string, unknown>) => {
          if (closed) return
          if ((controller.desiredSize ?? 0) <= 0) {
            fail(new LingxiError(502, "web_stream_overflow"))
            return
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          )
        }
        // Undici's WebSocket uses redirect:"error" and supports the explicit
        // proxy dispatcher; never send a cookie through a redirect or bypass a proxy.
        try {
          ws = new WebSocket(url.href, {
            headers: {
              Cookie: client.cookieHeader(),
              Origin: client.origin,
              "User-Agent": WPS_UA,
            },
            dispatcher: proxy,
          })
        } catch {
          fail(new LingxiError(502, "web_connection_failed"))
          return
        }
        abort = () => fail(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        ws.onopen = () => {
          try {
            ws?.send(
              JSON.stringify({
                event: "user.input",
                data: { agent_input: webInput(prompt, model, payload) },
              }),
            )
          } catch {
            fail(new LingxiError(502, "web_send_failed"))
          }
        }
        let reasoning = ""
        ws.onmessage = (event) => {
          if (closed || typeof event.data !== "string") return
          let frame: Record<string, unknown>
          try {
            frame = record(JSON.parse(event.data))
          } catch {
            fail(new LingxiError(502, "invalid_web_frame"))
            return
          }
          const data = record(frame.data)
          const failure = envelopeFailure({ ...frame, ...data })
          if (
            failure
            || frame.event === "error"
            || frame.event === "force.stop"
          ) {
            fail(failure ?? new LingxiError(502, "web_stream_error"))
            return
          }
          if (
            frame.event === "component.content"
            && typeof data.delta === "string"
          ) {
            if (data.type === "c_text")
              emit({ choices: [{ text: data.delta }] })
            if (data.type === "c_reasoning") {
              reasoning += data.delta
              emit({ choices: [{ reasoning_content: data.delta }] })
            }
          } else if (frame.event === "component.end") {
            const usage = record(data.full_content).usage
            if (usage) emit({ usage })
            if (
              data.type === "c_reasoning"
              && typeof data.full_content === "string"
              && data.full_content.startsWith(reasoning)
            ) {
              emit({
                choices: [
                  {
                    reasoning_content: data.full_content.slice(
                      reasoning.length,
                    ),
                  },
                ],
              })
              reasoning = ""
            }
          } else if (
            ["run.end", "stream.end", "done"].includes(String(frame.event))
          ) {
            emit({ choices: [{ finish_reason: "stop" }] })
            if (!closed) controller.close()
            close()
          }
        }
        ws.onerror = () => fail(new LingxiError(502, "web_connection_failed"))
        ws.onclose = () => fail(new LingxiError(502, "truncated_web_stream"))
      },
      cancel: close,
    },
    { highWaterMark: 256 },
  )
}

function webInput(
  prompt: string,
  model: string,
  payload: ChatCompletionsPayload,
): Record<string, unknown> {
  const max = payload.max_completion_tokens ?? payload.max_tokens
  return {
    text: prompt,
    expect_model: model,
    files: [],
    file_ids: [],
    refs: [],
    webpage_edit_selections: [],
    current_mode: "agent",
    permission_mode: "default",
    browser_plugin_enabled: false,
    ...(typeof max === "number"
      && Number.isInteger(max)
      && max > 0 && { max_tokens: max }),
    ...(payload.reasoning_effort && {
      reasoning_effort: payload.reasoning_effort,
    }),
  }
}
