import {
  getConnectionProxyUrl,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"
import {
  credentialClient,
  identifier,
  record,
  WPS_PATHS,
} from "~/services/wps-lingxi/client"

export function isLingxiModel(id: string): boolean {
  return Boolean(
    id && !["auto", "plan_pro", "plan_max"].includes(id.toLowerCase()),
  )
}

function quantity(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim()))
    return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

function mapping(id: string, model: Record<string, unknown>): ModelMapping {
  const efforts =
    Array.isArray(model.reasoning_efforts) ?
      [...new Set(model.reasoning_efforts)].filter(
        (effort): effort is string =>
          typeof effort === "string"
          && ["low", "medium", "high", "max"].includes(effort),
      )
    : []
  const multiplier =
    typeof model.multiplier === "string" ?
      model.multiplier.replace(/[x~≈～〜∼\s]/gi, "")
    : model.multiplier
  return {
    publicId: id,
    upstreamId: id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : id,
    endpoints: ["chat"],
    enabled: true,
    ...(efforts.length ? { efforts } : {}),
    metadata: {
      context: quantity(model.max_context_tokens) || 1_048_576,
      maxOutputTokens: quantity(model.max_new_tokens) || 65_536,
      supportsVision: model.support_multimodal === true,
      creditMultiplier: quantity(multiplier),
    },
  }
}

export function fallbackLingxiModels(): Array<ModelMapping> {
  // Offline snapshot from Magpie, not a claim that these models are still live.
  return [
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["deepseek-v4-flash-0731", "DeepSeek V4 Flash"],
    ["deepseek-v4-pro-0813", "DeepSeek V4 Pro"],
    ["kimi-k3", "Kimi-K3"],
    ["GLM-5.3", "GLM-5.3"],
    ["GLM-5.3-Flash", "GLM-5.3-Flash"],
    ["qwen3.8_max", "Qwen3.8-Max"],
    ["qwen3.8_flash", "Qwen3.8-Flash"],
    ["minimax_m3", "MiniMax-M3"],
    ["doubao_seed_2_1_pro_260628", "Doubao-Seed-2.1 Pro"],
    ["mimo-v2.6-pro", "Xiaomi MiMo-V2.6 Pro"],
  ].map(([id, name]) =>
    mapping(id, {
      name,
      max_context_tokens: id.startsWith("doubao") ? 262_144 : undefined,
    }),
  )
}

export async function discoverLingxiModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
  credential = connection.credentials[0],
): Promise<Array<ModelMapping>> {
  if (!credential) return []
  const client = credentialClient(credential, {
    proxyUrl: getConnectionProxyUrl(connection),
    signal,
  })
  const data = await client.json(WPS_PATHS.models)
  const models = new Map<string, ModelMapping>()
  for (const row of Array.isArray(data.models) ? data.models : []) {
    const model = record(row)
    const id = typeof model.key === "string" ? identifier(model.key) : undefined
    if (id && isLingxiModel(id)) models.set(id, mapping(id, model))
  }
  return [...models.values()]
}

function expiringWindows(value: unknown, now: number): Array<QuotaWindow> {
  if (!Array.isArray(value)) return []
  const batches = new Map<number, number>()
  for (const row of value) {
    const item = record(row)
    if (typeof item.expire_time !== "string") continue
    const date = item.expire_time.replace(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/,
      "$1T$2+08:00",
    )
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(date)) continue
    const expires = Date.parse(date)
    const remaining = quantity(item.balance)
    if (expires > now && remaining && expires <= now + 15 * 86_400_000) {
      batches.set(expires, (batches.get(expires) ?? 0) + remaining)
    }
  }
  return [...batches]
    .sort(([a], [b]) => a - b)
    .map(([expiresAtMs, remaining]) => ({
      id: `bonus-${expiresAtMs}`,
      remaining,
      expiresAtMs,
      unit: "credits",
      aside: true,
    }))
}

export async function fetchLingxiQuota(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ProviderQuotaSnapshot | undefined> {
  const credential = connection.credentials[0]
  if (!credential) return undefined
  const client = credentialClient(credential, {
    proxyUrl: getConnectionProxyUrl(connection),
    signal,
  })
  const data = await client.json(WPS_PATHS.balance)
  const remaining = quantity(data.total_balance ?? data.balance)
  const fetchedAt = Date.now()
  const bonus = record(data.bonus_summary)
  const display = expiringWindows(data.bonus_credits ?? bonus.items, fetchedAt)
  return {
    provider: "wps-lingxi",
    fetchedAt,
    unlimited: false,
    allowance:
      remaining === undefined ?
        { state: "unknown", windows: display }
      : {
          state: "known",
          // Bonus batches are already counted in the wallet; expiry is not a reset.
          windows: [{ id: "credits", unit: "credits", remaining }, ...display],
        },
    details: {
      total_balance: remaining,
      bonus_total: quantity(bonus.total_value),
      bonus_consumed: quantity(bonus.total_consumed),
    },
  }
}
