import type { Account, AccountModel } from "~/lib/accounts"

import { state } from "~/lib/state"

interface CodebuffModelCandidate {
  id?: unknown
  model?: unknown
  name?: unknown
  vendor?: unknown
}

function resolveCodebuffConfig(account: Account): {
  authToken?: string
  baseUrl: string
  model: string
} {
  const normalizedModel =
    account.availableModels?.[0]?.id ?? state.codebuffModel

  return {
    authToken: account.codebuffAuthToken ?? state.codebuffAuthToken,
    baseUrl: (account.codebuffBaseUrl ?? state.codebuffBaseUrl).replace(
      /\/+$/,
      "",
    ),
    model: normalizedModel,
  }
}

function toAccountModel(
  candidate: CodebuffModelCandidate,
): AccountModel | undefined {
  let idCandidate: string | undefined
  if (typeof candidate.id === "string") {
    idCandidate = candidate.id
  } else if (typeof candidate.model === "string") {
    idCandidate = candidate.model
  }

  if (!idCandidate) {
    return undefined
  }

  const name =
    typeof candidate.name === "string" && candidate.name.trim().length > 0 ?
      candidate.name
    : idCandidate

  const vendor =
    typeof candidate.vendor === "string" && candidate.vendor.trim().length > 0 ?
      candidate.vendor
    : "codebuff"

  return {
    id: idCandidate,
    name,
    vendor: vendor.toLowerCase() === "codebuff" ? "codebuff" : vendor,
    pickerEnabled: true,
    supportedEndpoints: ["/chat/completions"],
  }
}

function extractModels(payload: unknown): Array<AccountModel> {
  if (!payload || typeof payload !== "object") {
    return []
  }

  const roots = [
    payload as Record<string, unknown>,
    (payload as { me?: unknown }).me as Record<string, unknown> | undefined,
    (payload as { data?: unknown }).data as Record<string, unknown> | undefined,
    (payload as { user?: unknown }).user as Record<string, unknown> | undefined,
  ].filter(Boolean) as Array<Record<string, unknown>>

  const modelArrays: Array<unknown> = []
  for (const root of roots) {
    if (Array.isArray(root.availableModels))
      modelArrays.push(root.availableModels)
    if (Array.isArray(root.available_models))
      modelArrays.push(root.available_models)
    if (Array.isArray(root.models)) modelArrays.push(root.models)
  }

  const result: Array<AccountModel> = []
  const seen = new Set<string>()

  for (const source of modelArrays) {
    for (const item of source as Array<unknown>) {
      let model: AccountModel | undefined
      if (typeof item === "string") {
        model = toAccountModel({ id: item, name: item })
      } else if (typeof item === "object" && item) {
        model = toAccountModel(item as CodebuffModelCandidate)
      }

      if (!model || seen.has(model.id)) {
        continue
      }

      seen.add(model.id)
      result.push(model)
    }
  }

  return result
}

function fallbackModels(defaultModel: string): Array<AccountModel> {
  return [
    {
      id: defaultModel,
      name: defaultModel,
      vendor: "codebuff",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
    },
  ]
}

export async function getCodebuffModelsForAccount(
  account: Account,
): Promise<Array<AccountModel>> {
  const { authToken, baseUrl, model } = resolveCodebuffConfig(account)
  if (!authToken) {
    return fallbackModels(model)
  }

  const response = await fetch(
    `${baseUrl}/api/v1/me?fields=models,availableModels,available_models,user,data`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch codebuff models: ${response.status}`)
  }

  const body = await response.json()
  const parsed = extractModels(body)

  if (parsed.length > 0) {
    return parsed.map((item) => ({
      ...item,
      vendor: item.vendor || "codebuff",
    }))
  }

  return fallbackModels(model)
}
