import { asNumber, asRecordOrEmpty, asTrimmedString } from "~/lib/json-shape"
import type {
  ApiCredential,
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import { codeArtsKeys, readCodeArts } from "~/services/codearts/client"
import { codeArtsStations } from "~/services/codearts/stations"

export const CODEARTS_MAX_OUTPUT = 65_536
const ALL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]
const reasoningIds = new Set([
  "deepseek-v4.1-flash-1017",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.2-sft-harmony",
  "openpangu-2.0-pro",
  "openpangu-2.0-flash",
  "speed",
])

export function codeArtsEfforts(model: string): Array<string> | undefined {
  const id = model.toLowerCase()
  if (id === "glm-5.3-flash") return ["none", "low", "high", "max"]
  if (id === "kimi-k3" || id === "kimi-k3.1-pro") return ALL_EFFORTS.slice(1)
  if (reasoningIds.has(id)) return [...ALL_EFFORTS]
  return undefined
}

const FALLBACK_CONTEXT: Record<string, number> = {
  "glm-5.2": 202_752,
  "glm-5.3-flash": 1_048_576,
  "deepseek-v4.1-flash": 1_000_000,
  "deepseek-v4-flash": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
}

function modelMapping(id: string, row: Record<string, unknown>): ModelMapping {
  const params = asRecordOrEmpty(row.model_parameters)
  const efforts = codeArtsEfforts(id)
  const context =
    asNumber(params.context_window ?? row.context_window)
    || FALLBACK_CONTEXT[id.toLowerCase().replace(/-\d{4}$/, "")]
  const output = asNumber(params.max_tokens ?? row.max_tokens)
  const credit = row.credit ?? params.credit
  const tier = asRecordOrEmpty(Array.isArray(credit) ? credit[0] : credit)
  const rate = Number.parseFloat(
    String(tier.ratio_display ?? tier.ratioDisplay ?? ""),
  )
  return {
    publicId: id,
    upstreamId: id,
    name: asTrimmedString(row.display_name ?? row.model_name) ?? id,
    vendor: "codearts",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    efforts,
    metadata: {
      imageInput: false,
      contextWindow: context,
      maxOutput:
        output && output > 0 ?
          Math.min(output, CODEARTS_MAX_OUTPUT)
        : CODEARTS_MAX_OUTPUT,
      codeartsCreditRate: Number.isFinite(rate) && rate > 0 ? rate : undefined,
      ...(efforts || params.thinking_type != null ? { reasoning: true } : {}),
    },
  }
}

export function codeArtsFallbackModels(): Array<ModelMapping> {
  // Gateway-only benefit models are not usable without a claim. They are not
  // fallback routes: use the station's builtin / main-agent catalog instead.
  return ["GLM-5.2", "GLM-5.1", "openpangu-2.0-flash", "openpangu-2.0-pro"].map(
    (id) => modelMapping(id, {}),
  )
}

function records(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? raw.map(asRecordOrEmpty) : []
}

function collectModels(
  builtin: unknown,
  agent: Array<Record<string, unknown>>,
): Array<ModelMapping> {
  const rows = new Map<string, Record<string, unknown>>()
  for (const item of records(builtin)) {
    const id = asTrimmedString(item.model_id)
    if (id && !/-vl(?:-|$)/i.test(id) && !rows.has(id)) rows.set(id, item)
  }
  for (const item of agent) {
    const params = asRecordOrEmpty(item.model_parameters)
    const id = asTrimmedString(params.model_id ?? item.model_id)
    if (
      !id
      || /-vl(?:-|$)/i.test(id)
      || item.model_type === "third"
      || item.model_type === "custom"
      || item.is_custom_model === true
      || item.display_enabled === false
      || params.display_enabled === false
    )
      continue
    const builtinRow = rows.get(id)
    rows.set(id, {
      ...builtinRow,
      ...item,
      display_name:
        builtinRow?.model_name ?? item.display_name ?? item.model_name,
    })
  }
  return [...rows].map(([id, row]) => modelMapping(id, row))
}

type ReadStation = (
  path: string,
  agentType: string,
) => Promise<Record<string, unknown> | undefined>

async function readMainAgent(read: ReadStation) {
  const root = await read(
    "/v1/agent-center/agents/useragents?offset=0&limit=100",
    "AgentCenter",
  )
  const agents = records(root?.agents ?? asRecordOrEmpty(root?.data).agents)
  const rank = (name: unknown) =>
    name === "build" ? 0
    : name === "CodeAgent" ? 1
    : 2
  const ids = new Set(
    agents
      .sort(
        (a, b) =>
          rank(a.original_id ?? a.agent_id) - rank(b.original_id ?? b.agent_id),
      )
      .map((a) => asTrimmedString(a.agent_id))
      .filter(Boolean),
  )
  ids.add("a8bcb36232554267a5142361cc25a393")
  for (const id of [...ids].slice(0, 3)) {
    if (!id) continue
    const detail = await read(
      `/v1/agent-center/agents/detail?${new URLSearchParams({ agent_id: id })}`,
      "AgentCenter",
    )
    const gpts = asRecordOrEmpty(
      detail?.gpts ?? asRecordOrEmpty(detail?.data).gpts,
    )
    const models = records(gpts.models)
    if (models.length) return models
  }
  return []
}

export async function discoverCodeArtsModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
  credential?: ApiCredential,
): Promise<Array<ModelMapping>> {
  const keys = codeArtsKeys(credential ?? connection.credentials[0])
  const station = codeArtsStations[keys.station]
  const read: ReadStation = (path, agentType) =>
    readCodeArts(connection, keys, {
      url: new URL(path, station.snap),
      signal,
      headers: {
        "Content-Type": "application/json",
        "Agent-Type": agentType,
        "X-Language": station.locale,
      },
    })
  const [builtin, agent] = await Promise.all([
    read("/v1/model/builtin", "PromptCenter"),
    readMainAgent(read),
  ])
  const models = collectModels(builtin?.builtinModels, agent)
  if (!Array.isArray(builtin?.builtinModels) && !agent.length)
    throw new Error("CodeArts model discovery unavailable")
  return models
}
