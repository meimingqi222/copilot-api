// ── OpenAI SSE chunk construction ───────────────────────────────────────────

export function chunkFromText(opts: {
  requestId: string
  model: string
  text: string
  field: "content" | "reasoning_text" | "reasoning_opaque"
}): string {
  const { requestId, model, text, field } = opts
  let delta: Record<string, string>
  switch (field) {
    case "content": {
      delta = { content: text }
      break
    }
    case "reasoning_text": {
      delta = { reasoning_text: text }
      break
    }
    case "reasoning_opaque": {
      delta = { reasoning_opaque: text }
      break
    }
    default: {
      throw new Error("Unsupported Windsurf chunk field")
    }
  }
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

export function chunkFromToolCallInit(opts: {
  requestId: string
  model: string
  toolIndex: number
  callId: string
  toolName: string
}): string {
  const { requestId, model, toolIndex, callId, toolName } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              id: callId,
              type: "function",
              function: { name: toolName, arguments: "" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

export function chunkFromToolCallArgs(opts: {
  requestId: string
  model: string
  toolIndex: number
  args: string
}): string {
  const { requestId, model, toolIndex, args } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: toolIndex, function: { arguments: args } }],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

export function doneChunk(opts: {
  requestId: string
  model: string
  finishReason: "stop" | "length" | "tool_calls" | "content_filter"
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cached_tokens?: number
    cache_write_tokens?: number
    cache_read_tokens?: number
  }
}): string {
  const { requestId, model, finishReason, usage } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ?
      {
        usage: {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
          prompt_tokens_details: {
            cached_tokens: usage.cache_read_tokens ?? usage.cached_tokens ?? 0,
            ...(usage.cache_write_tokens ?
              { cache_creation_input_tokens: usage.cache_write_tokens }
            : {}),
          },
        },
      }
    : {}),
  })
}
