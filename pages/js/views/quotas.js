function quotasView() {
  return {
    ...ViewHelpers,
    ...usageAutoRefresh("quotas"),
    loading: false,
    refreshing: false,
    refreshingAccountId: null,
    resettingAccountId: null,
    claimingZcodeId: null,
    checkingZcodeId: null,
    accounts: [],
    showCreditDetails: {},

    init() {
      this.initAutoRefresh()
      this.load()
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "quotas") {
            this.load()
          }
        })
      }
    },

    async load() {
      if (this.loading) return
      this.loading = true
      try {
        const data = await API.quota.get()
        this.accounts = data.accounts || []
        this.lastUpdatedAt = Date.now()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
    },

    async refreshCachedUsage() {
      const data = await API.quota.get()
      if (
        JSON.stringify(this.accounts) !== JSON.stringify(data.accounts || [])
      ) {
        this.accounts = data.accounts || []
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
      this.lastUpdatedAt = Date.now()
    },

    quotaUpdatedTime(account) {
      const at = account.quotaInfo?.fetchedAt
      return at ? new Date(at).toLocaleString() : "—"
    },

    quotaRelativeTime(account) {
      const at = account.quotaInfo?.fetchedAt
      if (!at) return "—"
      const deltaSec = Math.max(0, Math.floor((Date.now() - at) / 1000))
      if (deltaSec < 60) return this.t("quota.updatedJustNow") || "刚刚更新"
      const deltaMin = Math.floor(deltaSec / 60)
      if (deltaMin < 60) {
        return `${deltaMin} ${this.t("quota.minutesAgo") || "分钟前更新"}`
      }
      const deltaHour = Math.floor(deltaMin / 60)
      if (deltaHour < 24) {
        return `${deltaHour} ${this.t("quota.hoursAgo") || "小时前更新"}`
      }
      return new Date(at).toLocaleDateString()
    },

    getCodexPlanSummary(account) {
      return QuotaDisplay.getCodexPlanSummary(account, (key, params) =>
        this.t(key, params),
      )
    },

    getCodexResetCreditsInfo(account) {
      return QuotaDisplay.getCodexResetCreditsInfo(account, (key, params) =>
        this.t(key, params),
      )
    },

    isCriticalQuota(row) {
      return QuotaDisplay.isCriticalQuota(row)
    },

    toggleCreditDetails(accountId) {
      this.showCreditDetails = {
        ...this.showCreditDetails,
        [accountId]: !this.showCreditDetails[accountId],
      }
    },

    async refresh() {
      this.refreshing = true
      try {
        await API.quota.refresh()
        this.showToast(I18n.t("quota.refreshSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("quota.refreshError"), "error")
      } finally {
        this.refreshing = false
      }
    },

    canResetCodexQuota(account) {
      return QuotaDisplay.canResetCodexQuota(account)
    },

    async resetAccountQuota(account) {
      if (!account?.id || !this.canResetCodexQuota(account)) return
      const confirmed = globalThis.confirm(
        this.t("quota.oauth.codex.resetConfirm", { name: account.label }),
      )
      if (!confirmed) return

      this.resettingAccountId = account.id
      try {
        const result = await API.quota.resetOne(account.id)
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            quotaInfo: result.quotaInfo ?? this.accounts[idx].quotaInfo,
            quotaState: result.quotaState ?? this.accounts[idx].quotaState,
          }
        }
        this.showToast(I18n.t("quota.oauth.codex.resetSuccess"), "success")
      } catch {
        this.showToast(I18n.t("quota.oauth.codex.resetError"), "error")
      } finally {
        this.resettingAccountId = null
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
    },

    // ── ZCode 限时套餐（活动赠送额度）────────────────────────────
    zcodePlans(account) {
      const plans = account?.zcodeClaim?.plans
      if (!Array.isArray(plans)) return []
      const holds = account?.zcodeClaim?.holds || {}
      const now = Date.now()
      return plans.filter((plan) => !(holds[plan.planId] > now))
    },

    zcodeHoldText(account) {
      const holds = account?.zcodeClaim?.holds || {}
      const next = Object.values(holds)
        .filter((at) => at > Date.now())
        .sort((a, b) => a - b)[0]
      if (!next) return ""
      return this.t("quota.zcode.holdUntil", {
        time: new Date(next).toLocaleString(),
      })
    },

    formatZcodeUnits(units) {
      const value = Number(units) || 0
      if (value >= 1_000_000) {
        const scaled = value / 1_000_000
        return `${scaled % 1 === 0 ? scaled : scaled.toFixed(1)}M`
      }
      if (value >= 1_000) return `${Math.round(value / 1_000)}K`
      return String(value)
    },

    zcodePlanSummary(account) {
      const plan = this.zcodePlans(account)[0]
      if (!plan) return ""
      const grant = plan.grants?.[0]
      if (!grant) return plan.name
      return `${plan.name} · ${grant.name} ${this.formatZcodeUnits(grant.units)}`
    },

    async checkZcodePlans(account) {
      if (!account?.id || this.checkingZcodeId) return
      this.checkingZcodeId = account.id
      try {
        const result = await API.zcode.preview(account.id)
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            zcodeClaim: result.state ?? this.accounts[idx].zcodeClaim,
          }
        }
        const count = Array.isArray(result.plans) ? result.plans.length : 0
        this.showToast(
          count > 0 ?
            this.t("quota.zcode.checkFound", { count })
          : this.t("quota.zcode.none"),
          count > 0 ? "success" : "info",
        )
      } catch (error) {
        this.showToast(
          error.message || this.t("quota.zcode.checkError"),
          "error",
        )
      } finally {
        this.checkingZcodeId = null
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
    },

    async claimZcodePlan(account) {
      if (!account?.id || this.claimingZcodeId) return
      const plan = this.zcodePlans(account)[0]
      this.claimingZcodeId = account.id
      try {
        const result = await API.zcode.claim(
          account.id,
          plan ? { planId: plan.planId } : {},
        )
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            zcodeClaim: result.state ?? this.accounts[idx].zcodeClaim,
          }
        }
        this.showToast(
          this.t("quota.zcode.claimSuccess", {
            name: result.claim?.planName || plan?.name || "",
          }),
          "success",
        )
        // 领到的额度立刻重读一次，卡片上的窗口跟着变。
        await this.refreshAccountQuota(account)
      } catch (error) {
        this.showToast(
          error.message || this.t("quota.zcode.claimError"),
          "error",
        )
        await this.load()
      } finally {
        this.claimingZcodeId = null
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
    },

    async refreshAccountQuota(account) {
      if (!account?.id) return
      this.refreshingAccountId = account.id
      try {
        const result = await API.quota.refreshOne(account.id)
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            quotaInfo: result.quotaInfo ?? this.accounts[idx].quotaInfo,
            quotaState: result.quotaState ?? this.accounts[idx].quotaState,
            rateLimitedModels:
              result.rateLimitedModels ?? this.accounts[idx].rateLimitedModels,
          }
        }
        this.showToast(I18n.t("accounts.quotaRefreshSuccess"), "success")
      } catch {
        this.showToast(I18n.t("accounts.quotaRefreshError"), "error")
      } finally {
        this.refreshingAccountId = null
        this.$nextTick(() => refreshAdminIcons(this.$el))
      }
    },

    getQuotaRows(account) {
      return QuotaDisplay.applyDisplayMode(
        QuotaDisplay.buildRows(account, (key, params) => this.t(key, params)),
        this.quotaDisplayMode,
        (key) => this.t(key),
      )
    },

    /**
     * 模型级冷却台账行：仍在冷却的模型 + 恢复倒计时。
     * 后端给 retryAfterSeconds（剩余秒），这里折算成恢复时刻复用
     * QuotaDisplay.formatResetTime 的相对时间文案。
     */
    getRateLimitedModelRows(account) {
      const items =
        Array.isArray(account?.rateLimitedModels) ?
          account.rateLimitedModels
        : []
      const t = (key, params) => this.t(key, params)
      return items
        .filter((item) => item && typeof item.model === "string")
        .map((item) => ({
          id: `rate-limited-${item.model}`,
          label: item.model,
          valueText: QuotaDisplay.formatResetTime(
            new Date(Date.now() + (item.retryAfterSeconds || 0) * 1000),
            t,
          ),
          hideBar: true,
        }))
    },

    getQuotaBarColor(row) {
      return QuotaDisplay.getBarColor(row?.remainingPercent)
    },

    getQuotaCardClass(provider) {
      return QuotaDisplay.providerCardClass(provider)
    },

    getQuotaBadgeClass(provider) {
      return QuotaDisplay.providerBadgeClass(provider)
    },

    getProviderDisplayName(provider) {
      return QuotaDisplay.providerDisplayName(provider, (key) => this.t(key))
    },

    getQuotaAccounts() {
      return (this.accounts || []).filter((a) => a.supportsQuota !== false)
    },

    getGeneralAccounts() {
      return (this.accounts || []).filter((a) => a.supportsQuota === false)
    },

    /**
     * Preferred provider order for quota sections. Keeps dense providers
     * (xai/codex) separate from sparse ones (antigravity) so card heights
     * stay consistent within each group.
     */
    PROVIDER_ORDER: [
      "copilot",
      "codex",
      "xai",
      "claude",
      "antigravity",
      "kimi",
      "minimax",
      "windsurf",
      "codebuddy",
      "codebuddy-cn",
      "codebuff",
      "mimo-aistudio",
    ],

    getAccountsByProvider(provider) {
      return (this.accounts || []).filter(
        (a) => (a.provider || "copilot") === provider,
      )
    },

    /** Providers that currently have at least one account, sorted. */
    getProviderGroups() {
      const counts = new Map()
      for (const account of this.accounts || []) {
        const provider = account.provider || "copilot"
        counts.set(provider, (counts.get(provider) || 0) + 1)
      }
      const known = this.PROVIDER_ORDER.filter((p) => counts.has(p))
      const extras = [...counts.keys()]
        .filter((p) => !this.PROVIDER_ORDER.includes(p))
        .sort()
      return [...known, ...extras].map((provider) => ({
        provider,
        count: counts.get(provider) || 0,
        accounts: this.getAccountsByProvider(provider),
        dense: false,
      }))
    },

    isUniqueSubtitle(subtitle) {
      if (!subtitle) return false
      return (
        (this.accounts || []).filter((a) => a.subtitle === subtitle).length
        === 1
      )
    },
  }
}
