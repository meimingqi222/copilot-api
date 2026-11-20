import { HTTPError } from "~/lib/error"
import { asNumber, asRecord, asTrimmedString } from "~/lib/json-shape"
import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import {
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { MEOO_GATEWAY, meooServiceAk } from "~/services/meoo/client"
import { oauthFetch, type OAuthFetchOptions } from "~/services/oauth/fetch"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import {
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"
import type { ProtocolAdapter } from "~/services/protocols/types"

const specs = new Map<string, [string, number, number, boolean?]>([
  ["qwen3.8-flash", ["Qwen3.8-Flash", 1_000_000, 131_072, true]],
  ["qwen3.8-max", ["Qwen3.8-Max", 1_000_000, 131_072, true]],
  ["qwen3.7-max", ["Qwen3.7-Max", 1_000_000, 131_072]],
  ["qwen3.7-plus", ["Qwen3.7-Plus", 1_000_000, 131_072, true]],
  [
    "deepseek-v4.1-flash-1017",
    ["DeepSeek V4.1 Flash", 1_000_000, 384_000, true],
  ],
  ["deepseek-v4-pro-0813", ["DeepSeek V4 Pro", 1_000_000, 384_000]],
  ["deepseek-v4-flash-0731", ["DeepSeek V4 Flash", 1_000_000, 384_000]],
  ["glm-5.2-fast-preview", ["GLM-5.2-Fast", 1_000_000, 128_000]],
  ["glm-5.2", ["GLM-5.2", 1_000_000, 128_000]],
  ["qwen3-vl-plus", ["Qwen VL", 262_144, 32_768, true]],
])

function modelMapping(
  id: string,
  entry?: Record<string, unknown>,
): ModelMapping {
  const [name, contextWindow, outputLimit, multimodal = false] = specs.get(
    id,
  ) ?? [id, 200_000, 65_536]
  return {
    publicId: canonicalNativeModelId(id),
    upstreamId: id,
    name: asTrimmedString(entry?.name) ?? name,
    vendor: "meoo",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    efforts: ["low", "medium", "high"],
    metadata: {
      contextWindow: positiveLimit(entry?.context) ?? contextWindow,
      outputLimit:
        positiveLimit(
          entry?.max_output ?? entry?.max_output_tokens ?? entry?.max_tokens,
        ) ?? outputLimit,
      multimodal,
    },
  }
}

function positiveLimit(value: unknown): number | undefined {
  const number = asNumber(value)
  return number && number > 0 && Number.isSafeInteger(number) ?
      number
    : undefined
}

export function meooFallbackModels(): Array<ModelMapping> {
  return [...specs.keys()]
    .filter((id) => id !== "qwen3-vl-plus")
    .map((id) => modelMapping(id))
}

export async function listMeooModels(
  ak: string,
  options: OAuthFetchOptions,
): Promise<Array<ModelMapping>> {
  const timeout = AbortSignal.timeout(15_000)
  const res = await oauthFetch(
    `${MEOO_GATEWAY}/models`,
    {
      redirect: "manual",
      headers: { Authorization: `Bearer ${ak}`, Accept: "application/json" },
    },
    {
      ...options,
      signal:
        options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    },
  )
  if (!res.ok) {
    await res.body?.cancel()
    throw new HTTPError(
      "Meoo gateway did not return a catalog.",
      new Response(null, { status: res.status }),
    )
  }
  const raw: unknown = await res.json()
  const data = asRecord(raw)
  const entries = data?.data ?? data?.models ?? raw
  if (!Array.isArray(entries)) throw new Error("Invalid Meoo model catalog.")
  const models = new Map<string, ModelMapping>()
  for (const item of entries as Array<unknown>) {
    const entry = asRecord(item)
    const id = asTrimmedString(entry?.id ?? item)
    if (id && /^[a-z\d][a-z\d._/-]{0,159}$/i.test(id)) {
      const model = modelMapping(id, entry)
      if (!models.has(model.publicId)) models.set(model.publicId, model)
    }
  }
  if (entries.length && !models.size)
    throw new Error("Meoo catalog contains no valid model IDs.")
  return [...models.values()]
}

export function discoverMeooModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const ak = meooServiceAk(connection.credentials[0])
  if (!ak)
    return Promise.reject(new Error("Meoo project service AK is missing."))
  return listMeooModels(ak, {
    proxyUrl: getConnectionProxyUrl(connection),
    signal,
  })
}

export const meooNativeAdapter: ProtocolAdapter = {
  protocol: "meoo-native",
  async createChatCompletions({
    connection,
    credential,
    target,
    payload,
    signal,
  }) {
    const ak = meooServiceAk(credential)
    if (!ak)
      throw new HTTPError(
        "Meoo project service AK is missing.",
        new Response(null, { status: 401 }),
      )
    const res = await oauthFetch(
      `${MEOO_GATEWAY}/chat/completions`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${ak}`,
          "Content-Type": "application/json",
        },
        body: serializeUpstreamBody({
          ...payload,
          model: target.upstreamModelId,
        }),
      },
      { proxyUrl: getConnectionProxyUrl(connection), signal },
    )
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      throw new HTTPError(
        "Meoo gateway returned an unexpected redirect.",
        new Response(null, { status: 502 }),
      )
    }
    if (!res.ok)
      await handleUpstreamFailure(res, credential, "Meoo chat failed", "meoo")
    if (payload.stream)
      return {
        credentialId: credential.id,
        response: await safeSseStream<CopilotStreamEvent>(
          res,
          detectOpenAIStreamError,
        ),
      }
    return {
      credentialId: credential.id,
      response: (await readUpstreamJson(res)) as ChatCompletionResponse,
    }
  },
}
