function quotasView() {
  return {
    ...ViewHelpers,
    loading: false,
    refreshing: false,
    refreshingAccountId: null,
    resettingAccountId: null,
    accounts: [],

    init() {
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
      this.loading = true
      try {
        const data = await API.quota.get()
        this.accounts = data.accounts || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
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
        this.$nextTick(() => lucide.createIcons())
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
          }
        }
        this.showToast(I18n.t("accounts.quotaRefreshSuccess"), "success")
      } catch {
        this.showToast(I18n.t("accounts.quotaRefreshError"), "error")
      } finally {
        this.refreshingAccountId = null
        this.$nextTick(() => lucide.createIcons())
      }
    },

    getQuotaRows(account) {
      return QuotaDisplay.buildRows(account, (key, params) =>
        this.t(key, params),
      )
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
      "windsurf",
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
