import { z } from "zod"

export const SYSTEM_CONFIG_KEY = "system-diagnostics-v1"

function environmentLogStorage(): {
  logRetentionDays: number
  logMaxTotalBytes: number
} {
  const days = Number(process.env.LOG_RETENTION_DAYS)
  const bytes = Number(process.env.LOG_MAX_TOTAL_BYTES)
  return {
    logRetentionDays:
      Number.isSafeInteger(days) && days > 0 && days <= 3650 ? days : 7,
    logMaxTotalBytes:
      Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 ** 4 ?
        bytes
      : 1024 ** 3,
  }
}

const settingsSchema = z
  .object({
    logLevel: z.enum(["warn", "info", "debug"]),
    requestDump: z.boolean(),
    memoryVerbose: z.boolean(),
    performanceDetails: z.boolean(),
    codexAutoReset: z.boolean().default(false),
    quotaDisplayMode: z.enum(["remaining", "used"]).default("remaining"),
    logRetentionDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(() => environmentLogStorage().logRetentionDays),
    logMaxTotalBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 ** 4)
      .default(() => environmentLogStorage().logMaxTotalBytes),
  })
  .strict()

export const systemConfigUpdateSchema = settingsSchema
  .extend({
    logRetentionDays: settingsSchema.shape.logRetentionDays
      .removeDefault()
      .optional(),
    logMaxTotalBytes: settingsSchema.shape.logMaxTotalBytes
      .removeDefault()
      .optional(),
    debugMinutes: z.number().int().min(1).max(120),
    acknowledgeSensitiveData: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => !value.requestDump || value.acknowledgeSensitiveData === true,
    {
      message: "Request dumps require explicit sensitive-data acknowledgement.",
    },
  )

const storedSchema = z
  .object({
    settings: settingsSchema,
    expiresAt: z.number().finite().nonnegative().nullable(),
  })
  .strict()

type SystemSettings = z.infer<typeof settingsSchema>
type StoredConfig = z.infer<typeof storedSchema>

const safeDefaults: SystemSettings = {
  logLevel: "info",
  requestDump: false,
  memoryVerbose: false,
  performanceDetails: true,
  codexAutoReset: false,
  quotaDisplayMode: "remaining",
  ...environmentLogStorage(),
}

let defaults = { ...safeDefaults }
let stored: StoredConfig | undefined
let persist: ((value: string) => void) | undefined
let apply: ((settings: SystemSettings) => void) | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function effectiveSettings(now = Date.now()): SystemSettings {
  if (!stored) {
    Object.assign(defaults, environmentLogStorage())
    defaults.requestDump = ["1", "true", "yes"].includes(
      process.env.DUMP_REQUESTS?.trim().toLowerCase() ?? "",
    )
    defaults.memoryVerbose = process.env.MEMORY_DIAGNOSTICS_VERBOSE === "true"
    return defaults
  }
  if (stored.expiresAt !== null && stored.expiresAt <= now) {
    return {
      ...stored.settings,
      logLevel:
        stored.settings.logLevel === "debug" ?
          "info"
        : stored.settings.logLevel,
      requestDump: false,
      memoryVerbose: false,
    }
  }
  return stored.settings
}

export function getSystemSettings(): Readonly<SystemSettings> {
  return effectiveSettings()
}

export function getSystemConfig(): {
  settings: SystemSettings
  source: "environment" | "webui"
  expiresAt: number | null
} {
  return {
    settings: { ...effectiveSettings() },
    source: stored ? "webui" : "environment",
    expiresAt: stored?.expiresAt ?? null,
  }
}

function applySettings(): void {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = undefined
  apply?.({ ...effectiveSettings() })
  if (stored?.expiresAt && stored.expiresAt > Date.now()) {
    expiryTimer = setTimeout(applySettings, stored.expiresAt - Date.now())
    expiryTimer.unref()
  }
}

export function initializeSystemConfig(options: {
  value?: string
  verbose?: boolean
  save: (value: string) => void
  onChange: (settings: SystemSettings) => void
}): void {
  defaults = {
    ...safeDefaults,
    logLevel:
      options.verbose || process.env.LOG_FILE_DEBUG === "true" ?
        "debug"
      : "info",
    requestDump: ["1", "true", "yes"].includes(
      process.env.DUMP_REQUESTS?.trim().toLowerCase() ?? "",
    ),
    memoryVerbose: process.env.MEMORY_DIAGNOSTICS_VERBOSE === "true",
  }
  stored = undefined
  if (options.value) {
    const parsed = storedSchema.safeParse(JSON.parse(options.value) as unknown)
    if (!parsed.success) throw new Error("Invalid saved system configuration")
    stored = parsed.data
  }
  persist = options.save
  apply = options.onChange
  applySettings()
}

export function updateSystemConfig(
  input: unknown,
): ReturnType<typeof getSystemConfig> {
  const parsed = systemConfigUpdateSchema.parse(input)
  const {
    debugMinutes,
    acknowledgeSensitiveData: _acknowledge,
    ...settings
  } = parsed
  const debugging =
    settings.logLevel === "debug"
    || settings.requestDump
    || settings.memoryVerbose
  const next: StoredConfig = {
    settings: {
      ...settings,
      logRetentionDays:
        settings.logRetentionDays ?? effectiveSettings().logRetentionDays,
      logMaxTotalBytes:
        settings.logMaxTotalBytes ?? effectiveSettings().logMaxTotalBytes,
    },
    expiresAt: debugging ? Date.now() + debugMinutes * 60_000 : null,
  }
  if (!persist) throw new Error("System configuration has not been initialized")
  persist(JSON.stringify(next))
  stored = next
  applySettings()
  return getSystemConfig()
}
