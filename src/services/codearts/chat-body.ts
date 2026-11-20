import { createHash } from "node:crypto"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { maskUpstream } from "~/lib/redaction/context"
import {
  codeArtsEfforts,
  CODEARTS_MAX_OUTPUT,
} from "~/services/codearts/models"
import type { CodeArtsStation } from "~/services/codearts/stations"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

function toolNameMap(body: ChatCompletionsPayload): Map<string, string> {
  const names = new Set(body.tools?.map((t) => t.function.name))
  for (const msg of body.messages) {
    if (msg.role === "tool" && msg.name) names.add(msg.name)
    for (const call of msg.tool_calls ?? []) names.add(call.function.name)
  }
  const choice = body.tool_choice
  if (typeof choice === "object" && choice?.type === "function")
    names.add(choice.function.name)
  const occupied = new Set([...names].filter((name) => name.length <= 64))
  const map = new Map<string, string>()
  for (const name of [...names].sort()) {
    if (name.length <= 64) continue
    let shortened: string
    let salt = 0
    do {
      const input = salt === 0 ? name : `${name}\0${salt}`
      shortened = `${name.slice(0, 55)}_${createHash("sha256").update(input).digest("hex").slice(0, 8)}`
      salt++
    } while (occupied.has(shortened))
    occupied.add(shortened)
    map.set(name, shortened)
  }
  return map
}

function mapToolNames(body: ChatCompletionsPayload, map: Map<string, string>) {
  const rename = (name: string) => map.get(name) ?? name
  const choice = body.tool_choice
  return {
    ...body,
    tools:
      body.tools?.map((t) => ({
        ...t,
        function: { ...t.function, name: rename(t.function.name) },
      })) ?? body.tools,
    tool_choice:
      typeof choice === "object" && choice?.type === "function" ?
        { ...choice, function: { name: rename(choice.function.name) } }
      : choice,
    messages: body.messages.map((msg) => ({
      ...msg,
      ...(msg.role === "tool" && msg.name ? { name: rename(msg.name) } : {}),
      ...(msg.tool_calls ?
        {
          tool_calls: msg.tool_calls.map((call) => ({
            ...call,
            function: { ...call.function, name: rename(call.function.name) },
          })),
        }
      : {}),
    })),
  }
}

export function prepareCodeArtsChat(
  payload: ChatCompletionsPayload,
  upstreamId: string,
  station: CodeArtsStation,
) {
  if (
    payload.messages.some(
      (msg) =>
        msg.images?.length
        || (Array.isArray(msg.content)
          && msg.content.some((part) => part.type === "image_url")),
    )
  ) {
    throw new LocalPayloadUnsupportedError("CodeArts models accept text only")
  }
  const model = upstreamId.replace(/^codearts\//, "")
  const mapped = maskUpstream(payload)
  const names = toolNameMap(mapped)
  const body = { ...mapToolNames(mapped, names), model, stream: true }
  const effort =
    typeof body.reasoning_effort === "string" ?
      body.reasoning_effort.toLowerCase()
    : undefined
  const levels = codeArtsEfforts(model)
  const wire: Record<string, unknown> = body
  const injected = !effort && wire.thinking === undefined
  if (injected) wire.thinking = { type: "enabled" }
  if (effort && ["none", "off", "disabled"].includes(effort)) {
    if (wire.thinking === undefined) wire.thinking = { type: "disabled" }
    delete wire.reasoning_effort
  } else if (effort && levels && !levels.includes(effort))
    delete wire.reasoning_effort
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const value = wire[key]
    if (typeof value === "number")
      wire[key] = Math.min(value, CODEARTS_MAX_OUTPUT)
  }
  const stop = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter(
    (value) => typeof value === "string" && value !== "",
  )
  if (station === "international" && stop.length) wire.stop = stop
  else delete wire.stop // Mainland rejects even a one-element stop sequence.
  return {
    wire,
    model,
    injected,
    names: new Map([...names].map(([original, short]) => [short, original])),
  }
}
