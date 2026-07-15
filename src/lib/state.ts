import type { Account } from "~/lib/accounts"
import type { ProviderId } from "~/lib/provider-config"
import type { User } from "~/lib/users"
import type { ModelsResponse } from "~/services/copilot/get-models"

import {
  connectionToAccount,
  listProviderConnections,
  readAccountLegacyMetadata,
} from "~/lib/provider-connections"
import { CACHE_UTILIZATION_DEFAULTS } from "~/lib/routing/provider-cache"

interface CodebuffProviderDefaults {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  model: string
  costMode: string
  allowFallbacks: boolean
}

interface WindsurfProviderDefaults {
  apiKey?: string
  baseUrl: string
  defaultModel: string
}

/**
 * L0 multi-account routing (CPA routing + codex.identity-confuse gate).
 *
 * Defaults target maximum prompt-cache utilization (see CACHE_UTILIZATION_DEFAULTS).
 * L1 provider rewrites are NOT configured here — they live in services/<provider>/.
 */
export interface RoutingConfig {
  strategy: "round-robin" | "fill-first" | "fillfirst" | "ff"
  sessionAffinity: boolean
  sessionAffinityTtlMs: number
  /** Codex-only L1. Requires sessionAffinity or fill-first. */
  identityConfuse: boolean
}

export interface State {
  // Multi-account support
  /**
   * 批次 2：state.accounts 是从 stateRoot.connections 反构造的缓存数组。
   * 通过 syncAccountsFromConnections() 刷新。
   * 写入应通过 connection mutation helpers，再调用 syncAccountsFromConnections()。
   */
  accounts: Array<Account>
  /** 批次 2：activeAccountIndex 保留但不再用于 account 选择（被 selectRouteTarget 取代）。 */
  activeAccountIndex: number

  // Multi-user support
  users: Array<User>

  // CLI/env global API key (--api-key / API_KEY) for legacy single-key mode
  legacyApiKey?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  providerDefaults: {
    codebuff: CodebuffProviderDefaults
    windsurf: WindsurfProviderDefaults
  }

  defaultProvider?: ProviderId

  routing: RoutingConfig

  manualApprove: boolean
  showToken: boolean
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number
}

/**
 * 从 stateRoot.connections 反构造 Account 列表（仅 account-derived connections）。
 * 用于 syncAccountsFromConnections() 刷新 state.accounts 缓存。
 */
function deriveAccountsFromConnections(): Array<Account> {
  const connections = listProviderConnections()
  const accounts: Array<Account> = []
  for (const conn of connections) {
    if (!readAccountLegacyMetadata(conn)) continue
    accounts.push(connectionToAccount(conn))
  }
  return accounts
}

/**
 * 刷新 state.accounts 缓存从 stateRoot.connections。
 * 在 connection mutation 后调用，确保 state.accounts 与 connections 一致。
 */
export function syncAccountsFromConnections(): void {
  state.accounts = deriveAccountsFromConnections()
}

export const state: State = {
  accounts: [],
  activeAccountIndex: 0,
  users: [],
  accountType: "individual",
  providerDefaults: {
    codebuff: {
      baseUrl: "https://www.codebuff.com",
      cliVersion: "0.0.33",
      agentId: "base",
      model: "z-ai/glm-5.1",
      costMode: "normal",
      allowFallbacks: true,
    },
    windsurf: {
      baseUrl: "https://server.codeium.com",
      defaultModel: "swe-1-6-fast",
    },
  },
  // Max prompt-cache utilization defaults (fill-first + session affinity).
  routing: { ...CACHE_UTILIZATION_DEFAULTS },
  manualApprove: false,
  showToken: false,
}
