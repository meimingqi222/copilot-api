import { randomBytes } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { hashKeyPart, PersistentTTLMap } from "~/lib/cache/persistent-map"
import { asRecord, asString } from "~/lib/json-shape"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"

type Item = Record<string, unknown>
interface ReplayBatch {
  items: Array<{ index: number; item: Item }>
}

const cache = new PersistentTTLMap<ReplayBatch>(
  "responses-tool-replay-v1",
  60 * 60_000,
  256,
)
const MAX_BATCH_BYTES = 120 * 1024
const REPLAY_ID = /^call_rp_([a-f0-9]{32})_(\d+)$/
let initialized: Promise<void> | undefined

function sameCall(left: Item, right: Item): boolean {
  if (left.name !== right.name || left.namespace !== right.namespace)
    return false
  if (left.arguments === right.arguments) return true
  if (typeof left.arguments !== "string" || typeof right.arguments !== "string")
    return false
  try {
    return isDeepStrictEqual(
      JSON.parse(left.arguments),
      JSON.parse(right.arguments),
    )
  } catch {
    return false
  }
}

/** Carries a Responses upstream's own reasoning through standard Chat tool IDs. */
export class ResponsesToolReplay {
  private readonly token = randomBytes(16).toString("hex")
  private readonly items = new Map<number, Item>()
  private readonly itemIndices = new Map<string, number>()
  private readonly carried = new Set<number>()
  private nextIndex = 0
  private hasReasoning = false
  private readonly scope: string

  constructor(scope: string) {
    this.scope = scope
  }

  private key(token: string): string {
    return hashKeyPart(`${this.scope}\0${token}`)
  }

  async restore(payload: ResponsesPayload): Promise<ResponsesPayload> {
    if (!Array.isArray(payload.input)) return payload
    await (initialized ??= cache.init())
    const batches = new Map<string, ReplayBatch | undefined>()
    const restored = new Set<string>()
    const callIds = new Map<string, string>()
    const clientCalls = new Map(
      payload.input.flatMap((value) => {
        const item = asRecord(value)
        return (
            item?.type === "function_call" && typeof item.call_id === "string"
          ) ?
            [[item.call_id, item] as const]
          : []
      }),
    )
    const input: Array<Item> = []
    let stepStart = 0
    for (const value of payload.input) {
      const item = asRecord(value)
      if (!item) continue
      if (item.type === "function_call") {
        const clientId = asString(item.call_id) ?? ""
        const match = REPLAY_ID.exec(clientId)
        if (match) {
          const token = match[1]!
          if (!batches.has(token)) {
            let batch = cache.get(this.key(token))
            if (
              batch?.items.some((part) => {
                const client = clientCalls.get(`call_rp_${token}_${part.index}`)
                return (
                  part.item.type === "function_call"
                  && client
                  && !sameCall(client, part.item)
                )
              })
            )
              batch = undefined
            batches.set(token, batch)
          }
          const batch = batches.get(token)
          const index = Number(match[2])
          const call = batch?.items.find((part) => part.index === index)?.item
          if (call?.type === "function_call" && sameCall(item, call)) {
            const reasoning = batch!.items
              .filter(
                (part) => part.index < index && part.item.type === "reasoning",
              )
              .filter((part) => !restored.has(`${token}:${part.index}`))
            for (const part of reasoning) restored.add(`${token}:${part.index}`)
            input.splice(
              stepStart,
              0,
              ...reasoning.map((part) => ({ ...part.item })),
            )
            callIds.set(clientId, asString(call.call_id) ?? clientId)
            input.push({ ...call })
            stepStart = input.length
            continue
          }
        }
      }
      if (item.type === "function_call_output") {
        input.push({
          ...item,
          call_id: callIds.get(String(item.call_id)) ?? item.call_id,
        })
      } else {
        input.push(item)
      }
      if (
        item.type === "function_call"
        || (item.type !== "reasoning" && item.role !== "assistant")
      ) {
        stepStart = input.length
      }
    }
    return {
      ...payload,
      input: input as ResponsesPayload["input"],
      include: [
        ...new Set([...(payload.include ?? []), "reasoning.encrypted_content"]),
      ],
    }
  }

  private observe(item: Item, hint?: number): number {
    const id = asString(item.id) ?? asString(item.call_id)
    const index =
      hint ?? (id ? this.itemIndices.get(id) : undefined) ?? this.nextIndex++
    this.nextIndex = Math.max(this.nextIndex, index + 1)
    if (id) this.itemIndices.set(id, index)
    if (item.type === "reasoning") this.hasReasoning = true
    const previous = this.items.get(index)
    if (
      item.type === "reasoning"
      && previous?.type === "reasoning"
      && previous.id === item.id
      && asString(previous.encrypted_content)
      && !asString(item.encrypted_content)
    )
      return index
    if (item.type === "reasoning" || item.type === "function_call")
      this.items.set(index, item)
    return index
  }

  private carry(item: Item, index: number): Item {
    if (item.type !== "function_call" || !this.hasReasoning) return item
    this.carried.add(index)
    return { ...item, call_id: `call_rp_${this.token}_${index}` }
  }

  async response(response: ResponsesResponse): Promise<ResponsesResponse> {
    for (const [index, value] of (response.output ?? []).entries())
      this.observe(value as unknown as Item, index)
    if (!this.hasReasoning) return response
    const output = response.output?.map((value, index) =>
      this.carry(value as unknown as Item, index),
    )
    if (this.carried.size > 0 && response.status === "completed") {
      const batch: ReplayBatch = {
        items: [...this.items]
          .sort(([a], [b]) => a - b)
          .map(([index, item]) => ({ index, item })),
      }
      if (Buffer.byteLength(JSON.stringify(batch)) <= MAX_BATCH_BYTES) {
        await (initialized ??= cache.init())
        cache.set(this.key(this.token), batch)
      }
    }
    return {
      ...response,
      ...(output && {
        output: output as unknown as ResponsesResponse["output"],
      }),
    }
  }

  async *stream(
    upstream: AsyncIterable<CopilotStreamEventLike>,
  ): AsyncIterable<CopilotStreamEventLike> {
    for await (const event of upstream) {
      const data = event.data
      if (
        !data
        || (!data.includes("response.output_item.")
          && !data.includes("response.completed")
          && !data.includes("response.incomplete"))
      ) {
        yield event
        continue
      }
      const packet = JSON.parse(data) as Item
      if (
        packet.type === "response.output_item.added"
        || packet.type === "response.output_item.done"
      ) {
        const item = asRecord(packet.item)
        if (item) {
          const index = this.observe(
            item,
            typeof packet.output_index === "number" ?
              packet.output_index
            : undefined,
          )
          packet.item = this.carry(item, index)
        }
      } else if (
        (packet.type === "response.completed"
          || packet.type === "response.incomplete")
        && packet.response
      ) {
        packet.response = await this.response(
          packet.response as ResponsesResponse,
        )
      }
      yield { ...event, data: JSON.stringify(packet) }
    }
  }
}
