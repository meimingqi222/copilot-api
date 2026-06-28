/**
 * Direct provider default account management.
 *
 * 启动时根据 CLI / env 提供的 codebuff/windsurf 默认配置,自动同步一个
 * "managed default" account 到 state.accounts。已存在的 managed default
 * 会更新 settings;新配置会创建新 account;不再配置的旧 account 保留不动。
 */
import { randomUUID } from "node:crypto"

import { saveAccounts } from "~/lib/account-store"
import {
  type CodebuffAccount,
  type WindsurfAccount,
  addAccount,
  getCodebuffAuthToken,
  getWindsurfApiKey,
} from "~/lib/accounts"
import { state } from "~/lib/state"

/**
 * 启动时同步 codebuff/windsurf 的 managed default account。
 * 有变更时持久化到磁盘。
 */
export async function ensureDirectProviderAccounts(): Promise<void> {
  let changed = false
  changed = syncCodebuffDefaultAccount() || changed
  changed = syncWindsurfDefaultAccount() || changed

  if (changed) {
    await saveAccounts()
  }
}

function syncCodebuffDefaultAccount(): boolean {
  const defaults = state.providerDefaults.codebuff
  if (!defaults.authToken) return false

  let changed = false
  const managedDefault = state.accounts.find((account) =>
    isCodebuffManagedDefaultAccount(account),
  )

  if (managedDefault) {
    const currentToken = getCodebuffAuthToken(managedDefault)
    if (currentToken !== defaults.authToken) {
      managedDefault.credentials = {
        ...managedDefault.credentials,
        authToken: defaults.authToken,
      }
      changed = true
    }
    changed = applyCodebuffDefaultsIfChanged(managedDefault) || changed
    return changed
  }

  const hasTokenAccount = state.accounts.some(
    (account) =>
      account.provider === "codebuff"
      && getCodebuffAuthToken(account) === defaults.authToken,
  )
  if (!hasTokenAccount) {
    addAccount(createCodebuffDefaultAccount())
    changed = true
  }

  return changed
}

function isCodebuffManagedDefaultAccount(account: {
  provider: string
  label: string
}): account is CodebuffAccount {
  return account.provider === "codebuff" && account.label === "codebuff-default"
}

function applyCodebuffDefaultsIfChanged(account: CodebuffAccount): boolean {
  const defaults = state.providerDefaults.codebuff
  const nextSettings = {
    ...account.settings,
    baseUrl: defaults.baseUrl,
    cliVersion: defaults.cliVersion,
    agentId: defaults.agentId,
    model: defaults.model,
    costMode: defaults.costMode,
    allowFallbacks: defaults.allowFallbacks,
  }
  if (settingsEqual(account.settings, nextSettings)) {
    return false
  }
  account.settings = nextSettings
  return true
}

function createCodebuffDefaultAccount() {
  const defaults = state.providerDefaults.codebuff
  return {
    id: randomUUID(),
    label: "codebuff-default",
    provider: "codebuff" as const,
    credentials: {
      authToken: defaults.authToken,
    },
    settings: {
      baseUrl: defaults.baseUrl,
      cliVersion: defaults.cliVersion,
      agentId: defaults.agentId,
      model: defaults.model,
      costMode: defaults.costMode,
      allowFallbacks: defaults.allowFallbacks,
    },
    enabled: true,
    priority: 0,
    quotaState: "unknown" as const,
    createdAt: Date.now(),
  }
}

function syncWindsurfDefaultAccount(): boolean {
  const defaults = state.providerDefaults.windsurf
  if (!defaults.apiKey) return false

  let changed = false
  const managedDefault = state.accounts.find((account) =>
    isWindsurfManagedDefaultAccount(account),
  )

  if (managedDefault) {
    const currentKey = getWindsurfApiKey(managedDefault)
    if (currentKey !== defaults.apiKey) {
      managedDefault.credentials = {
        ...managedDefault.credentials,
        apiKey: defaults.apiKey,
      }
      changed = true
    }
    changed = applyWindsurfDefaultsIfChanged(managedDefault) || changed
    return changed
  }

  const hasKeyAccount = state.accounts.some(
    (account) =>
      account.provider === "windsurf"
      && getWindsurfApiKey(account) === defaults.apiKey,
  )
  if (!hasKeyAccount) {
    addAccount(createWindsurfDefaultAccount())
    changed = true
  }

  return changed
}

function isWindsurfManagedDefaultAccount(account: {
  provider: string
  label: string
}): account is WindsurfAccount {
  return account.provider === "windsurf" && account.label === "windsurf-default"
}

function applyWindsurfDefaultsIfChanged(account: WindsurfAccount): boolean {
  const defaults = state.providerDefaults.windsurf
  const nextSettings = {
    ...account.settings,
    baseUrl: defaults.baseUrl,
    appVersion: defaults.appVersion,
    lsVersion: defaults.lsVersion,
    defaultModel: defaults.defaultModel,
    clientName: defaults.clientName,
    extensionName: defaults.extensionName,
    ideType: defaults.ideType,
  }
  if (settingsEqual(account.settings, nextSettings)) {
    return false
  }
  account.settings = nextSettings
  return true
}

function createWindsurfDefaultAccount() {
  const defaults = state.providerDefaults.windsurf
  return {
    id: randomUUID(),
    label: "windsurf-default",
    provider: "windsurf" as const,
    credentials: {
      apiKey: defaults.apiKey,
    },
    settings: {
      baseUrl: defaults.baseUrl,
      appVersion: defaults.appVersion,
      lsVersion: defaults.lsVersion,
      defaultModel: defaults.defaultModel,
      clientName: defaults.clientName,
      extensionName: defaults.extensionName,
      ideType: defaults.ideType,
    },
    enabled: true,
    priority: 0,
    quotaState: "unknown" as const,
    createdAt: Date.now(),
  }
}

function settingsEqual(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right)
}
