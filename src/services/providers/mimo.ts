import { randomUUID } from "node:crypto"

import type { AccountModel } from "~/lib/accounts"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import {
  type MimoMessage,
  mimoConnections,
  type MimoConnection,
} from "~/services/mimo/connections"

import type { ProviderRuntime } from "./runtime"

const MIMO_MODELS = [
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", vendor: "MiMo" },
  { id: "mimo-v2.5", name: "MiMo V2.5", vendor: "MiMo" },
  { id: "mimo-v2-pro", name: "MiMo V2 Pro", vendor: "MiMo" },
  { id: "mimo-v2-flash", name: "MiMo V2 Flash", vendor: "MiMo" },
  { id: "mimo-v2-omni", name: "MiMo V2 Omni", vendor: "MiMo" },
  { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", vendor: "MiMo" },
  { id: "mimo-v2-tts", name: "MiMo V2 TTS", vendor: "MiMo" },
]

export const mimoProviderRuntime: ProviderRuntime = {
  id: "mimo-aistudio",
  descriptor: {
    id: "mimo-aistudio",
    name: "Mimo AI Studio",
    icon: "cpu",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    accountFields: [
      {
        key: "userId",
        type: "text",
        labelKey: "accounts.provider.mimo-aistudio.fields.userId",
        required: true,
        placeholder: "e.g., 10001",
      },
      {
        key: "serviceToken",
        type: "secret",
        labelKey: "accounts.provider.mimo-aistudio.fields.serviceToken",
        required: true,
        placeholder: "serviceToken",
      },
      {
        key: "xiaomichatbotPh",
        type: "secret",
        labelKey: "accounts.provider.mimo-aistudio.fields.xiaomichatbotPh",
        required: true,
        placeholder: "xiaomichatbot_ph",
      },
    ],
  },
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(account) {
    const models: Array<AccountModel> = MIMO_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
      provider: "mimo-aistudio",
    }))
    account.availableModels = models
    return models
  },
  async createChatCompletions(account, payload, signal, _ctx) {
    const conn = mimoConnections.get(account.id)
    if (!conn) {
      throw new Error(
        `Claw node for account "${account.label}" is offline or initializing. Please wait.`,
      )
    }

    const req_id = randomUUID()

    const wsPayload = {
      req_id,
      method: "POST",
      path: "/v1/chat/completions",
      body: JSON.stringify(payload),
    }

    conn.ws.send(JSON.stringify(wsPayload))

    if (payload.stream) {
      return {
        accountId: account.id,
        response: streamResponse(conn, req_id, signal),
      }
    } else {
      const response = await collectResponse(conn, req_id, signal)
      return {
        accountId: account.id,
        response,
      }
    }
  },
}

async function* streamResponse(
  conn: MimoConnection,
  req_id: string,
  signal?: AbortSignal,
): AsyncIterable<any> {
  const queue: Array<MimoMessage> = []
  let resolveNext: (() => void) | null = null
  let done = false
  let error: any = null

  const listener = (msg: MimoMessage) => {
    queue.push(msg)
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(req_id, listener)

  const cleanup = () => {
    conn.activeRequests.delete(req_id)
  }

  if (signal) {
    signal.addEventListener("abort", () => {
      error = new Error("Request aborted")
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })
  }

  try {
    while (!done) {
      if (error) throw error

      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }

      if (error) throw error

      const msg = queue.shift()
      if (!msg) continue

      if (msg.type === "chunk" && msg.body) {
        const lines = msg.body.split("\n")
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6).trim()
            if (dataStr === "[DONE]") {
              // ignore
            } else {
              yield { data: dataStr }
            }
          }
        }
      } else if (msg.type === "finish") {
        done = true
      } else if (msg.type === "error") {
        throw new Error(msg.body || "Node returned an error")
      }
    }
    yield { data: "[DONE]" }
  } finally {
    cleanup()
  }
}

async function collectResponse(
  conn: MimoConnection,
  req_id: string,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const queue: Array<MimoMessage> = []
  let resolveNext: (() => void) | null = null
  let done = false
  let error: any = null
  let accumulatedBody = ""

  const listener = (msg: MimoMessage) => {
    queue.push(msg)
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(req_id, listener)

  const cleanup = () => {
    conn.activeRequests.delete(req_id)
  }

  if (signal) {
    signal.addEventListener("abort", () => {
      error = new Error("Request aborted")
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })
  }

  try {
    while (!done) {
      if (error) throw error

      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }

      if (error) throw error

      const msg = queue.shift()
      if (!msg) continue

      if (msg.type === "chunk" && msg.body) {
        accumulatedBody += msg.body
      } else if (msg.type === "finish") {
        done = true
      } else if (msg.type === "error") {
        throw new Error(msg.body || "Node returned an error")
      }
    }

    return JSON.parse(accumulatedBody) as ChatCompletionResponse
  } finally {
    cleanup()
  }
}
