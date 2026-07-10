// Provider-aware quota display helpers for the admin dashboard.
const QuotaDisplay = {
  OAUTH_PROVIDERS: new Set(["codex", "claude", "antigravity", "kimi", "xai"]),
  CYCLE_USAGE_PROVIDERS: new Set(["codex", "claude", "antigravity", "kimi"]),

  isOAuthProvider(provider) {
    return this.OAUTH_PROVIDERS.has(provider)
  },

  getDisplayType(provider) {
    if (provider === "kimi") return "count"
    if (provider === "xai") return "usd"
    if (this.isOAuthProvider(provider)) return "percent"
    return "copilot"
  },

  normalizeNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  },

  normalizeFraction(value) {
    const normalized = this.normalizeNumber(value)
    if (normalized !== undefined) {
      return normalized <= 1 ? normalized : normalized / 100
    }
    if (typeof value === "string" && value.trim().endsWith("%")) {
      const parsed = Number(value.trim().slice(0, -1))
      if (Number.isFinite(parsed)) return parsed / 100
    }
    return undefined
  },

  normalizeCentValue(value) {
    if (value === undefined || value === null) return undefined
    if (typeof value === "object" && !Array.isArray(value)) {
      return this.normalizeNumber(value.val)
    }
    return this.normalizeNumber(value)
  },

  formatUsdFromCents(cents) {
    if (cents === undefined || cents === null) return "N/A"
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(cents / 100)
  },

  formatCycleUsageCost(cost) {
    if (cost === undefined || cost === null || !Number.isFinite(cost)) {
      return "$0.00"
    }
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cost)
  },

  getCycleUsageMap(details) {
    if (!details || typeof details !== "object") return new Map()
    const windows = details._quotaWindows
    if (!Array.isArray(windows)) return new Map()
    const map = new Map()
    for (const window of windows) {
      if (!window || typeof window !== "object" || !window.id) continue
      const usage = window.cycleUsage
      if (!usage || typeof usage !== "object") continue
      map.set(window.id, usage)
    }
    return map
  },

  attachCycleUsageToRows(rows, details, provider, t) {
    if (!this.CYCLE_USAGE_PROVIDERS.has(provider)) return rows
    const usageMap = this.getCycleUsageMap(details)
    if (usageMap.size === 0) return rows
    return rows.map((row) => {
      if (row.hideBar) return row
      const usage = usageMap.get(row.id)
      if (!usage || !Number.isFinite(usage.cost) || usage.cost <= 0) {
        return row
      }
      return {
        ...row,
        cycleUsageText: t("quota.oauth.cycleUsage", {
          cost: this.formatCycleUsageCost(usage.cost),
        }),
      }
    })
  },

  formatUnixSeconds(value) {
    if (!value) return ""
    const date = new Date(value * 1000)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  },

  formatDateTimeValue(value) {
    if (value === undefined || value === null) return ""
    if (typeof value === "number" && Number.isFinite(value)) {
      return this.formatUnixSeconds(value)
    }
    const date = new Date(String(value))
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  },

  formatCodexResetLabel(resetAtSeconds) {
    if (!resetAtSeconds) return ""
    return this.formatUnixSeconds(resetAtSeconds)
  },

  getCodexMeta(details) {
    if (!details || typeof details !== "object") return null
    const meta = details._codexMeta
    if (!meta || typeof meta !== "object") return null
    return meta
  },

  formatCodexPlanType(planType, t) {
    const normalized =
      typeof planType === "string" ? planType.trim().toLowerCase() : ""
    if (!normalized) return null
    const key = `quota.oauth.codex.plan.${normalized.replaceAll("-", "")}`
    const translated = t(key)
    if (translated && translated !== key) return translated
    return planType
  },

  canResetCodexQuota(account) {
    const meta = this.getCodexMeta(account?.quotaInfo?.details)
    return (meta?.rateLimitResetCreditsAvailableCount ?? 0) > 0
  },

  getCodexPlanRows(account, t) {
    const meta = this.getCodexMeta(account?.quotaInfo?.details)
    if (!meta) return []
    const rows = []
    const planLabel = this.formatCodexPlanType(meta.planType, t)
    if (planLabel) {
      rows.push({
        id: "plan",
        label: t("quota.oauth.codex.planLabel"),
        valueText: planLabel,
        hideBar: true,
      })
    }
    if (meta.subscriptionActiveUntil) {
      rows.push({
        id: "subscription-expiry",
        label: t("quota.oauth.codex.expiresLabel"),
        valueText: this.formatDateTimeValue(meta.subscriptionActiveUntil),
        hideBar: true,
      })
    }
    if (
      meta.rateLimitResetCreditsAvailableCount !== null
      && meta.rateLimitResetCreditsAvailableCount !== undefined
    ) {
      rows.push({
        id: "reset-credits",
        label: t("quota.oauth.codex.resetCreditsLabel"),
        valueText: String(meta.rateLimitResetCreditsAvailableCount),
        hideBar: true,
      })
    }
    return rows
  },

  formatResetTime(resetAt, t) {
    if (!resetAt) return ""
    const resetMs = new Date(resetAt).getTime()
    if (Number.isNaN(resetMs)) return ""
    const deltaMs = resetMs - Date.now()
    if (deltaMs <= 0) return t("quota.oauth.resetAvailable")
    const totalMinutes = Math.max(1, Math.ceil(deltaMs / 60000))
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60
    if (days > 0) {
      return t("quota.oauth.resetInDays", { days, hours })
    }
    if (hours > 0) {
      return t("quota.oauth.resetInHours", { hours, minutes })
    }
    return t("quota.oauth.resetInMinutes", { minutes })
  },

  getBarColor(percent) {
    if (percent === undefined || percent === null) {
      return "bg-[var(--apple-green)]"
    }
    if (percent < 20) return "bg-[var(--apple-red)]"
    if (percent < 50) return "bg-[var(--apple-orange)]"
    return "bg-[var(--apple-green)]"
  },

  buildRows(account, t) {
    const provider = account.provider || "copilot"
    const info = account.quotaInfo
    if (!info) return []

    let rows
    switch (provider) {
      case "claude": {
        rows = this.buildClaudeRows(info.details, t)

        break
      }
      case "codex": {
        rows = [
          ...this.getCodexPlanRows(account, t),
          ...this.buildCodexRows(info.details, t),
        ]

        break
      }
      case "antigravity": {
        rows = this.buildAntigravityRows(info.details, t)

        break
      }
      case "kimi": {
        rows = this.buildKimiRows(info.details, t)

        break
      }
      case "xai": {
        rows = this.buildXaiRows(info.details, t)

        break
      }
      default: {
        rows = this.buildCopilotRows(info, t)
      }
    }

    return this.attachCycleUsageToRows(rows, info.details, provider, t)
  },

  buildClaudeRows(details, t) {
    if (!details || typeof details !== "object") return []
    const rows = []
    const windows = [
      ["five_hour", "quota.oauth.claude.fiveHour"],
      ["seven_day", "quota.oauth.claude.sevenDay"],
      ["seven_day_oauth_apps", "quota.oauth.claude.sevenDayOAuth"],
      ["seven_day_opus", "quota.oauth.claude.sevenDayOpus"],
      ["seven_day_sonnet", "quota.oauth.claude.sevenDaySonnet"],
      ["seven_day_cowork", "quota.oauth.claude.sevenDayCowork"],
    ]

    for (const [key, labelKey] of windows) {
      const window = details[key]
      if (!window || typeof window.utilization !== "number") continue
      const usedPercent = Math.max(0, Math.min(100, window.utilization * 100))
      rows.push({
        id: key,
        label: t(labelKey),
        remainingPercent: Math.max(0, 100 - usedPercent),
        valueText: `${Math.round(100 - usedPercent)}%`,
        resetText: this.formatResetTime(window.resets_at, t),
      })
    }

    const extra = details.extra_usage
    if (extra?.is_enabled) {
      const used = this.normalizeNumber(extra.used_credits) ?? 0
      const limit = this.normalizeNumber(extra.monthly_limit) ?? 0
      rows.push({
        id: "extra_usage",
        label: t("quota.oauth.claude.extraUsage"),
        valueText: `$${(used / 100).toFixed(2)} / $${(limit / 100).toFixed(2)}`,
        hideBar: true,
      })
    }

    return rows
  },

  collectCodexWindows(limitInfo, primaryKey, secondaryKey) {
    if (!limitInfo) return []
    const windows = []
    const primary = limitInfo.primary_window ?? limitInfo.primaryWindow
    const secondary = limitInfo.secondary_window ?? limitInfo.secondaryWindow
    if (primary) {
      windows.push({ window: primary, labelKey: primaryKey })
    }
    if (secondary) {
      windows.push({ window: secondary, labelKey: secondaryKey })
    }
    return windows
  },

  buildCodexRowsFromMeta(meta, t) {
    if (!meta?.windows?.length) return []
    return meta.windows.map((window) => {
      const used = window.usedPercent
      const clampedUsed =
        used === null || used === undefined ?
          null
        : Math.max(0, Math.min(100, used))
      const remaining =
        clampedUsed === null ? undefined : (
          Math.max(0, Math.min(100, 100 - clampedUsed))
        )
      const label =
        window.labelKey ? t(window.labelKey, window.labelParams) : window.label
      const resetText = this.formatCodexResetLabel(window.resetAtSeconds)
      return {
        id: window.id,
        label,
        remainingPercent: remaining,
        valueText: remaining === undefined ? "--" : `${Math.round(remaining)}%`,
        resetText,
      }
    })
  },

  buildCodexRows(details, t) {
    if (!details || typeof details !== "object") return []
    const meta = this.getCodexMeta(details)
    if (meta?.windows?.length) {
      return this.buildCodexRowsFromMeta(meta, t)
    }

    const rows = []
    const sources = [
      {
        info: details.rate_limit ?? details.rateLimit,
        primaryKey: "quota.oauth.codex.fiveHour",
        secondaryKey: "quota.oauth.codex.weekly",
        prefix: "code",
      },
      {
        info: details.code_review_rate_limit ?? details.codeReviewRateLimit,
        primaryKey: "quota.oauth.codex.codeReviewFiveHour",
        secondaryKey: "quota.oauth.codex.codeReviewWeekly",
        prefix: "review",
      },
    ]

    for (const source of sources) {
      for (const entry of this.collectCodexWindows(
        source.info,
        source.primaryKey,
        source.secondaryKey,
      )) {
        const usedPercent = this.normalizeNumber(
          entry.window.used_percent ?? entry.window.usedPercent,
        )
        if (usedPercent === undefined) continue
        const clampedUsed = Math.max(0, Math.min(100, usedPercent))
        rows.push({
          id: `${source.prefix}-${entry.labelKey}`,
          label: t(entry.labelKey),
          remainingPercent: Math.max(0, 100 - clampedUsed),
          valueText: `${Math.round(100 - clampedUsed)}%`,
        })
      }
    }

    const additional =
      details.additional_rate_limits ?? details.additionalRateLimits ?? []
    for (const [index, item] of additional.entries()) {
      const limitInfo = item.rate_limit ?? item.rateLimit
      const name =
        item.limit_name
        ?? item.limitName
        ?? item.metered_feature
        ?? item.meteredFeature
        ?? `additional-${index + 1}`
      for (const entry of this.collectCodexWindows(
        limitInfo,
        "quota.oauth.codex.additionalFiveHour",
        "quota.oauth.codex.additionalWeekly",
      )) {
        const usedPercent = this.normalizeNumber(
          entry.window.used_percent ?? entry.window.usedPercent,
        )
        if (usedPercent === undefined) continue
        const clampedUsed = Math.max(0, Math.min(100, usedPercent))
        const labelKey = entry.labelKey
        rows.push({
          id: `additional-${index}-${labelKey}`,
          label: t(labelKey, { name }),
          remainingPercent: Math.max(0, 100 - clampedUsed),
          valueText: `${Math.round(100 - clampedUsed)}%`,
        })
      }
    }

    return rows
  },

  buildAntigravityRows(details, t) {
    if (!details || typeof details !== "object") return []
    const rows = []
    for (const group of details.groups ?? []) {
      const groupLabel =
        group.displayName
        ?? group.display_name
        ?? t("quota.oauth.antigravity.group")
      for (const bucket of group.buckets ?? []) {
        const fraction = this.normalizeFraction(
          bucket.remainingFraction ?? bucket.remaining_fraction,
        )
        const bucketId =
          bucket.bucketId ?? bucket.bucket_id ?? bucket.window ?? "bucket"
        const bucketLabel =
          bucket.displayName
          ?? bucket.display_name
          ?? bucketId
          ?? t("quota.oauth.antigravity.bucket")
        rows.push({
          id: `${groupLabel}-${bucketId}`,
          label: `${groupLabel}: ${bucketLabel}`,
          remainingPercent:
            fraction !== undefined ?
              Math.max(0, Math.min(100, fraction * 100))
            : undefined,
          valueText:
            fraction !== undefined ?
              `${Math.round(Math.max(0, Math.min(100, fraction * 100)))}%`
            : "N/A",
          resetText: this.formatResetTime(
            bucket.resetTime ?? bucket.reset_time,
            t,
          ),
        })
      }
    }
    return rows
  },

  buildKimiRows(details, t) {
    if (!details || typeof details !== "object") return []
    const rows = []
    const items = [...(details.limits ?? [])]
    if (details.usage) {
      items.unshift({
        id: "summary",
        title: t("quota.oauth.kimi.usage"),
        detail: details.usage,
      })
    }

    for (const [index, item] of items.entries()) {
      const data = item.detail ?? item
      const limit = this.normalizeNumber(data.limit)
      const remaining = this.normalizeNumber(data.remaining)
      const used =
        this.normalizeNumber(data.used)
        ?? (limit !== undefined && remaining !== undefined ?
          Math.max(0, limit - remaining)
        : undefined)
      if (remaining === undefined && used === undefined) continue
      const rowId =
        item.id
        ?? (details.usage && index === 0 ?
          "summary"
        : `limit-${details.usage ? index - 1 : index}`)
      rows.push({
        id: rowId,
        label: item.title ?? item.name ?? t("quota.oauth.kimi.limit"),
        remaining,
        total: limit,
        used,
        valueText:
          limit !== undefined ?
            `${remaining ?? "N/A"} / ${limit}`
          : String(remaining ?? "N/A"),
        remainingPercent:
          limit && limit > 0 && remaining !== undefined ?
            Math.max(0, Math.min(100, (remaining / limit) * 100))
          : undefined,
      })
    }
    return rows
  },

  buildXaiRows(details, t) {
    if (!details || typeof details !== "object") return []
    const config = details.config
    if (!config || typeof config !== "object") return []

    const monthlyLimit = this.normalizeCentValue(
      config.monthlyLimit ?? config.monthly_limit,
    )
    const used = this.normalizeCentValue(config.used)
    const onDemandCap = this.normalizeCentValue(
      config.onDemandCap ?? config.on_demand_cap,
    )
    const rows = []

    const creditUsagePercent = this.normalizeNumber(config.creditUsagePercent)
    const currentPeriod =
      config.currentPeriod && typeof config.currentPeriod === "object" ?
        config.currentPeriod
      : null
    const monthlyPeriodEnd =
      config.monthlyBillingPeriodEnd
      ?? config.monthly_billing_period_end
      ?? config.billingPeriodEnd
      ?? config.billing_period_end
    const weeklyPeriodEnd =
      currentPeriod?.end ?? config.billingPeriodEnd ?? config.billing_period_end

    if (monthlyLimit !== undefined || used !== undefined) {
      const remainingCents =
        monthlyLimit !== undefined && used !== undefined ?
          Math.max(0, monthlyLimit - used)
        : undefined
      const remainingPercent =
        monthlyLimit && monthlyLimit > 0 && used !== undefined ?
          Math.max(
            0,
            Math.min(100, ((monthlyLimit - used) / monthlyLimit) * 100),
          )
        : undefined
      rows.push({
        id: "monthly-credits",
        label: t("quota.oauth.xai.monthlyCredits"),
        remainingCents,
        totalCents: monthlyLimit,
        usedCents: used,
        valueText:
          remainingPercent !== undefined ?
            `${Math.round(remainingPercent)}%`
          : "--",
        amountText:
          monthlyLimit !== undefined && remainingCents !== undefined ?
            `${this.formatUsdFromCents(remainingCents)} / ${this.formatUsdFromCents(monthlyLimit)}`
          : this.formatUsdFromCents(remainingCents),
        remainingPercent,
        resetText: this.formatResetTime(monthlyPeriodEnd, t),
      })
    }

    if (creditUsagePercent !== undefined) {
      const usedPercent = Math.max(0, Math.min(100, creditUsagePercent))
      const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
      rows.push({
        id: "weekly-credits",
        label: t("quota.oauth.xai.weeklyCredits"),
        valueText: `${Math.round(remainingPercent)}%`,
        amountText: t("quota.oauth.xai.usedPercent", {
          percent: usedPercent.toFixed(1),
        }),
        remainingPercent,
        resetText: this.formatResetTime(weeklyPeriodEnd, t),
      })
    }

    if (onDemandCap !== undefined) {
      rows.push({
        id: "pay-as-you-go",
        label: t("quota.oauth.xai.payAsYouGo"),
        valueText:
          onDemandCap > 0 ?
            t("quota.oauth.xai.payAsYouGoEnabled", {
              cap: this.formatUsdFromCents(onDemandCap),
            })
          : t("quota.oauth.xai.payAsYouGoDisabled"),
        hideBar: true,
      })
    }

    return rows
  },

  buildCopilotRows(info, t) {
    const rows = []
    if (info.premiumInteractionsRemaining !== undefined) {
      rows.push({
        id: "premium",
        label: t("quota.premium"),
        remaining: info.premiumInteractionsRemaining,
        total: info.premiumInteractionsTotal,
        valueText: `${info.premiumInteractionsRemaining ?? "N/A"} / ${info.premiumInteractionsTotal ?? "N/A"}`,
        remainingPercent:
          info.premiumInteractionsTotal ?
            (info.premiumInteractionsRemaining / info.premiumInteractionsTotal)
            * 100
          : undefined,
      })
    }
    if (info.chatRemaining !== undefined || info.unlimited) {
      rows.push({
        id: "chat",
        label: t("quota.chat"),
        valueText:
          info.unlimited ?
            t("quota.unlimited")
          : String(info.chatRemaining ?? "N/A"),
        hideBar: info.unlimited,
      })
    }
    if (info.completionsRemaining !== undefined || info.unlimited) {
      rows.push({
        id: "completions",
        label: t("quota.completions"),
        valueText:
          info.unlimited ?
            t("quota.unlimited")
          : String(info.completionsRemaining ?? "N/A"),
        hideBar: true,
      })
    }
    return rows
  },

  formatSummary(account, t) {
    if (account.supportsQuota === false) return t("quota.unavailable")
    const info = account.quotaInfo
    if (!info) return t("quota.noData")

    if (info.unlimited) return t("quota.unlimited")

    const provider = account.provider || "copilot"
    if (provider === "kimi") {
      if (info.chatRemaining !== undefined && info.chatTotal !== undefined) {
        return `${info.chatRemaining} / ${info.chatTotal}`
      }
      return t("quota.noData")
    }
    if (provider === "xai") {
      if (info.chatRemaining !== undefined && info.chatTotal !== undefined) {
        return `${this.formatUsdFromCents(info.chatRemaining)} / ${this.formatUsdFromCents(info.chatTotal)}`
      }
      if (info.premiumInteractionsRemaining !== undefined) {
        return `${Math.round(info.premiumInteractionsRemaining)}%`
      }
      return t("quota.noData")
    }
    if (this.isOAuthProvider(provider)) {
      if (info.premiumInteractionsRemaining !== undefined) {
        return `${info.premiumInteractionsRemaining}%`
      }
      return t("quota.noData")
    }
    if (info.premiumInteractionsRemaining !== undefined) {
      return `${info.premiumInteractionsRemaining} / ${info.premiumInteractionsTotal ?? "?"}`
    }
    if (info.chatRemaining !== undefined) {
      return String(info.chatRemaining)
    }
    return t("quota.noData")
  },

  providerCardClass(provider) {
    switch (provider) {
      case "claude": {
        return "quota-card-claude"
      }
      case "codex": {
        return "quota-card-codex"
      }
      case "antigravity": {
        return "quota-card-antigravity"
      }
      case "kimi": {
        return "quota-card-kimi"
      }
      case "xai": {
        return "quota-card-xai"
      }
      case "copilot": {
        return "quota-card-copilot"
      }
      default: {
        return ""
      }
    }
  },

  providerBadgeClass(provider) {
    const cardClass = this.providerCardClass(provider)
    if (!cardClass) return "quota-badge-copilot"
    return cardClass.replace("quota-card-", "quota-badge-")
  },

  providerDisplayName(provider, t) {
    const key = `accounts.provider.${provider}.name`
    const translated = t ? t(key) : ""
    if (translated && translated !== key) return translated
    if (!provider) return "Copilot"
    return provider.charAt(0).toUpperCase() + provider.slice(1)
  },
}
