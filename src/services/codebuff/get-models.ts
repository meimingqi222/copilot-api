import type { Account, AccountModel } from "~/lib/accounts"

import { state } from "~/lib/state"

function resolveCodebuffConfig(account: Account): {
  model: string
} {
  const normalizedModel =
    account.availableModels?.[0]?.id ?? state.codebuffModel

  return {
    model: normalizedModel,
  }
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

export function getCodebuffModelsForAccount(
  account: Account,
): Array<AccountModel> {
  const { model } = resolveCodebuffConfig(account)

  // Codebuff API does not have a /models endpoint and /me does not return model info
  // Always use fallback with configured model
  return fallbackModels(model)
}
