import type { OAuthProviderId } from "~/lib/provider-config"

import { logger } from "~/lib/logger"
import { isOAuthProviderId, isProviderId } from "~/lib/provider-config"

/**
 * Legacy account JSON 迁移器。
 *
 * 从 accounts.json 的 raw JSON 记录解析为 Account 对象。
 * 处理 legacy flat-field 格式（旧版 copilot-api 的扁平字段）到
 * 当前 Account 扁平结构的转换。
 *
 * 从 account-store.ts 提取以满足 max-lines lint 规则。
 */
import type {
  Account,
  AccountProvider,
  AccountQuotaState,
  AccountRuntimeState,
} from "./accounts"

function defaultProvider(provider?: AccountProvider): AccountProvider {
  return provider ?? "copilot"
}

export function migrateAccount(account: Record<string, unknown>): Account {
  const acc = migrateAccountInternal(account)
  if (typeof account.cooldownUntil === "number") {
    acc.cooldownUntil = account.cooldownUntil
  } else if (typeof account.cooldownUntil === "string") {
    const parsed = Date.parse(account.cooldownUntil)
    if (!Number.isNaN(parsed)) {
      acc.cooldownUntil = parsed
    }
  }
  return acc
}

type RawAccountJsonRecord = Record<string, unknown> & {
  isActive?: boolean
  enabled?: boolean
  priority?: number
  provider?: AccountProvider
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  codebuffAuthToken?: string
  codebuffBaseUrl?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks?: boolean
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfDefaultModel?: string
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  serviceToken?: string
  xiaomichatbotPh?: string
  mimoWsToken?: string
  userId?: string
  proxy?: string
  quotaState?: AccountQuotaState
  quotaExhaustedAt?: number
}

type MigratedAccountBase = Omit<
  Account,
  "provider" | "credentials" | "settings" | "runtimeState"
>

function pickString(primary: unknown, fallback: unknown): string | undefined {
  if (typeof primary === "string") {
    return primary
  }
  if (typeof fallback === "string") {
    return fallback
  }
  return undefined
}

function pickNumber(primary: unknown, fallback: unknown): number | undefined {
  if (typeof primary === "number") {
    return primary
  }
  if (typeof fallback === "number") {
    return fallback
  }
  return undefined
}

function pickBoolean(primary: unknown, fallback: unknown): boolean | undefined {
  if (typeof primary === "boolean") {
    return primary
  }
  if (typeof fallback === "boolean") {
    return fallback
  }
  return undefined
}

function normalizeLegacyAccount(
  account: Record<string, unknown>,
): RawAccountJsonRecord & Partial<Account> {
  const acc = account as RawAccountJsonRecord & Partial<Account>

  if (typeof acc.enabled !== "boolean" && typeof acc.isActive === "boolean") {
    acc.enabled = acc.isActive
    logger.debug(
      `Migrated account "${acc.label}" isActive → enabled: ${acc.enabled}`,
    )
  }

  if (typeof acc.enabled !== "boolean") {
    acc.enabled = true
  }

  if (typeof acc.priority !== "number") {
    acc.priority = 0
  }

  if (!isProviderId(String(acc.provider))) {
    acc.provider = "copilot"
  }

  if (
    acc.quotaState !== "available"
    && acc.quotaState !== "exhausted"
    && acc.quotaState !== "unknown"
  ) {
    acc.quotaState = "unknown"
  }

  return acc
}

function buildMigratedAccountBase(
  acc: RawAccountJsonRecord & Partial<Account>,
): MigratedAccountBase {
  return {
    id: String(acc.id),
    label: String(acc.label),
    enabled: acc.enabled ?? true,
    priority: acc.priority ?? 0,
    quotaState: acc.quotaState ?? "unknown",
    quotaExhaustedAt: acc.quotaExhaustedAt,
    availableModels: acc.availableModels,
    quotaInfo: acc.quotaInfo,
    cooldownUntil: acc.cooldownUntil,
    isExhausted: acc.isExhausted,
    exhaustedAt: acc.exhaustedAt,
    lastRateLimitAt: acc.lastRateLimitAt,
    lastRateLimitReason: acc.lastRateLimitReason,
    createdAt: typeof acc.createdAt === "number" ? acc.createdAt : Date.now(),
  }
}

function migrateCopilotAccount(
  base: MigratedAccountBase,
  acc: RawAccountJsonRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "copilot",
    credentials: {
      githubToken: pickString(
        existingCredentials?.githubToken,
        acc.githubToken,
      ),
    },
    settings: existingSettings ?? {},
    runtimeState: {
      ...existingRuntime,
      copilotToken: pickString(existingRuntime?.copilotToken, acc.copilotToken),
      copilotTokenExpiry: pickNumber(
        existingRuntime?.copilotTokenExpiry,
        acc.copilotTokenExpiry,
      ),
    },
  }
}

function migrateCodebuffAccount(
  base: MigratedAccountBase,
  acc: RawAccountJsonRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "codebuff",
    credentials: {
      authToken: pickString(
        existingCredentials?.authToken,
        acc.codebuffAuthToken,
      ),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, acc.codebuffBaseUrl),
      cliVersion: pickString(
        existingSettings?.cliVersion,
        acc.codebuffCliVersion,
      ),
      agentId: pickString(existingSettings?.agentId, acc.codebuffAgentId),
      model: pickString(existingSettings?.model, acc.codebuffModel),
      costMode: pickString(existingSettings?.costMode, acc.codebuffCostMode),
      allowFallbacks: pickBoolean(
        existingSettings?.allowFallbacks,
        acc.codebuffAllowFallbacks,
      ),
    },
    runtimeState: existingRuntime,
  }
}

function migrateWindsurfAccount(
  base: MigratedAccountBase,
  acc: RawAccountJsonRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "windsurf",
    credentials: {
      apiKey: pickString(existingCredentials?.apiKey, acc.windsurfApiKey),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, acc.windsurfBaseUrl),
      defaultModel: pickString(
        existingSettings?.defaultModel,
        acc.windsurfDefaultModel,
      ),
    },
    runtimeState: {
      ...existingRuntime,
      windsurfJwt: pickString(existingRuntime?.windsurfJwt, acc.windsurfJwt),
      windsurfJwtFetchedAt: pickNumber(
        existingRuntime?.windsurfJwtFetchedAt,
        acc.windsurfJwtFetchedAt,
      ),
    },
  }
}

function migrateMimoAccount(
  base: MigratedAccountBase,
  acc: RawAccountJsonRecord,
  existingCredentials: Record<string, unknown> | undefined,
  existingSettings: Record<string, unknown> | undefined,
  existingRuntime: AccountRuntimeState | undefined,
): Account {
  return {
    ...base,
    provider: "mimo-aistudio",
    credentials: {
      serviceToken: pickString(
        existingCredentials?.serviceToken,
        acc.serviceToken,
      ),
      xiaomichatbotPh: pickString(
        existingCredentials?.xiaomichatbotPh,
        acc.xiaomichatbotPh,
      ),
      mimoWsToken: pickString(
        existingCredentials?.mimoWsToken,
        acc.mimoWsToken,
      ),
    },
    settings: {
      userId: pickString(existingSettings?.userId, acc.userId),
      proxy: pickString(existingSettings?.proxy, acc.proxy),
    },
    runtimeState: existingRuntime,
  }
}

interface MigrateOAuthAccountInput {
  base: MigratedAccountBase
  provider: OAuthProviderId
  existingCredentials?: Record<string, unknown>
  existingSettings?: Record<string, unknown>
  existingRuntime?: AccountRuntimeState
  cpaMetadata?: Record<string, unknown>
}

function migrateOAuthAccount(input: MigrateOAuthAccountInput): Account {
  const {
    base,
    provider,
    existingCredentials,
    existingSettings,
    existingRuntime,
    cpaMetadata,
  } = input
  return {
    ...base,
    provider,
    credentials: {
      accessToken: pickString(existingCredentials?.accessToken, undefined),
      refreshToken: pickString(existingCredentials?.refreshToken, undefined),
      idToken: pickString(existingCredentials?.idToken, undefined),
      expiresAt: pickNumber(existingCredentials?.expiresAt, undefined),
      accountId: pickString(existingCredentials?.accountId, undefined),
      projectId: pickString(existingCredentials?.projectId, undefined),
      deviceId: pickString(existingCredentials?.deviceId, undefined),
      apiKey: pickString(existingCredentials?.apiKey, undefined),
      email: pickString(existingCredentials?.email, undefined),
    },
    settings: {
      baseUrl: pickString(existingSettings?.baseUrl, undefined),
      proxyUrl: pickString(existingSettings?.proxyUrl, undefined),
      modelPrefix: pickString(existingSettings?.modelPrefix, undefined),
      cpaSourcePath: pickString(existingSettings?.cpaSourcePath, undefined),
      tokenEndpoint: pickString(existingSettings?.tokenEndpoint, undefined),
      redirectUri: pickString(existingSettings?.redirectUri, undefined),
    },
    runtimeState: existingRuntime,
    cpaMetadata,
  }
}

function migrateAccountInternal(account: Record<string, unknown>): Account {
  const acc = normalizeLegacyAccount(account)
  const base = buildMigratedAccountBase(acc)
  const existingCredentials = acc.credentials
  const existingSettings = acc.settings
  const existingRuntime = acc.runtimeState
  const provider = defaultProvider(acc.provider)

  if (provider === "copilot") {
    return migrateCopilotAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (provider === "codebuff") {
    return migrateCodebuffAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (provider === "windsurf") {
    return migrateWindsurfAccount(
      base,
      acc,
      existingCredentials,
      existingSettings,
      existingRuntime,
    )
  }

  if (isOAuthProviderId(provider)) {
    return migrateOAuthAccount({
      base,
      provider,
      existingCredentials,
      existingSettings,
      existingRuntime,
      cpaMetadata: acc.cpaMetadata,
    })
  }

  return migrateMimoAccount(
    base,
    acc,
    existingCredentials,
    existingSettings,
    existingRuntime,
  )
}
