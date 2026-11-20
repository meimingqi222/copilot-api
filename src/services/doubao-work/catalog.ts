import { asNumber, asRecord, asStringFieldOrEmpty } from "~/lib/json-shape"
import { isEffortLevel, nearestEffort } from "~/lib/effort-levels"
import type { ModelMapping } from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot, QuotaWindow } from "~/lib/quota/types"

const efforts = [
  ["低", "low"],
  ["中", "medium"],
  ["高", "high"],
  ["极高", "xhigh"],
  ["最高", "max"],
] as const

export interface WorkModel {
  id: string
  label: string
  key?: string
  levels?: Array<string>
  defaultLevel?: string
  upgrade?: boolean
}

export const fallbackModels: ReadonlyArray<WorkModel> = [
  { id: "auto", label: "自动" },
  { id: "doubao-2.1-lite", label: "豆包 2.1 Lite" },
  { id: "doubao-2.1-pro", label: "豆包 2.1 Pro" },
]

const items = (value: unknown): Array<unknown> =>
  Array.isArray(value) ? value : []

function modelId(label: string): string {
  if (label === "自动") return "auto"
  const id = label
    .replaceAll("豆包", "doubao ")
    .replaceAll("高速", " fast ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "")
  const hash = Array.from(label).reduce(
    (sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) >>> 0,
    0,
  )
  return /^[a-z]/.test(id) ? id : `model-${id || hash.toString(36)}`
}

function table(rows: Array<Omit<WorkModel, "id">>): Array<WorkModel> {
  const byId = new Map<string, WorkModel>()
  const labels = new Set<string>()
  for (const row of rows) {
    if (
      !row.label
      || row.label === "快速"
      || row.label === "专家"
      || labels.has(row.label)
    )
      continue
    labels.add(row.label)
    const base = modelId(row.label)
    let id = base
    for (let n = 2; byId.has(id); n++) id = `${base}-${n}`
    byId.set(id, { ...row, id })
  }
  return [...byId.values()]
}

export function modelsFromBriefList(value: unknown): Array<WorkModel> {
  const conf = asRecord(value)
  const modes = items(asRecord(conf?.mode_list)?.item_list).map(asRecord)
  const work =
    modes.find((m) => String(m?.mode_id) === "3")
    ?? modes.find((m) => Number(m?.agent_mode) === 1)
    ?? modes.find(
      (m) =>
        items(m?.conversation_mode_list).includes("office")
        && (m?.default_conversation_mode ?? "office") === "office",
    )
  const own = items(asRecord(work?.model_list)?.item_list)
  const shared = items(asRecord(conf?.model_list)?.item_list)
  const keys = new Set(
    items(work?.support_models)
      .map((m) => String(asRecord(m)?.model_item_key ?? ""))
      .filter(Boolean),
  )
  const rows =
    own.length ? own
    : keys.size ?
      shared.filter((m) => keys.has(String(asRecord(m)?.model_item_key)))
    : modes.length ? []
    : shared
  return table(
    rows.map((value) => {
      const row = asRecord(value)
      const config = asRecord(row?.reasoning_effort_config)
      const options = items(config?.option_list).map(asRecord)
      return {
        label: asStringFieldOrEmpty(row, "name").trim(),
        key: String(row?.model_item_key ?? "") || undefined,
        levels: efforts
          .filter(([label]) => options.some((option) => option?.name === label))
          .map(([, key]) => key),
        defaultLevel: efforts.find(([label]) =>
          options.some(
            (option) =>
              option?.name === label && option.level === config?.default_level,
          ),
        )?.[1],
        upgrade: asRecord(row?.subscribe_config)?.need_upgrade === true,
      }
    }),
  )
}

export function modelsFromMenu(value: unknown): Array<WorkModel> {
  return table(
    items(value).map((value) => {
      const row = asRecord(value)
      return {
        label: asStringFieldOrEmpty(row, "label").trim(),
        upgrade: row?.upgrade === true,
      }
    }),
  )
}

export function effortLabel(
  model: WorkModel,
  requested: unknown,
): string | undefined {
  const want =
    typeof requested === "string" ? requested.trim().toLowerCase() : ""
  const key =
    efforts.find(([label]) => label === want)?.[1]
    ?? (want === "none" || want === "minimal" ? "low" : want)
  const level =
    isEffortLevel(key) && model.levels?.length ?
      nearestEffort(key, model.levels)
    : model.defaultLevel
  return efforts.find(([, key]) => key === level)?.[0]
}

export function workModelMappings(
  models: ReadonlyArray<WorkModel>,
): Array<ModelMapping> {
  return models.map((model) => ({
    publicId: model.id,
    upstreamId: model.id,
    name: model.label,
    aliases: [model.label, ...(model.key ? [model.key] : [])],
    vendor: "doubao-work",
    endpoints: ["chat"],
    enabled: true,
    efforts: model.levels,
    metadata: { doubaoWork: model },
  }))
}

function quotaWindows(section: unknown, scope: string): Array<QuotaWindow> {
  const group = asRecord(section)
  return items(group?.window_limit_groups).flatMap((entry, groupIndex) =>
    items(asRecord(entry)?.window_limits).flatMap((value, windowIndex) => {
      const row = asRecord(value)
      const percent = asNumber(row?.used_percent)
      if (percent === undefined && group?.usage_exhausted !== true) return []
      const from = asNumber(row?.start_time)
      const to = asNumber(row?.end_time)
      return [
        {
          id: `${scope}-${groupIndex}-${windowIndex}`,
          unit: "percent" as const,
          used:
            group?.usage_exhausted === true ?
              1
            : Math.max(0, Math.min(1, (percent ?? 0) / 100)),
          spanMs: from && to && to > from ? to - from : undefined,
          resetsAtMs: to && to > 0 ? to : undefined,
        },
      ]
    }),
  )
}

export function quotaSnapshot(
  value: unknown,
): ProviderQuotaSnapshot | undefined {
  const data = asRecord(asRecord(value)?.data)
  if (!data) return undefined
  const windows = [
    ...quotaWindows(data.window_limit_section, "personal"),
    ...quotaWindows(data.enterprise_window_limit_section, "enterprise"),
  ]
  const display = asRecord(asRecord(data.current_subscription)?.display)
  return {
    provider: "doubao-work",
    fetchedAt: Date.now(),
    unlimited: false,
    allowance: { state: windows.length ? "known" : "unknown", windows },
    details: { plan: display?.short_name ?? display?.product_name },
  }
}
