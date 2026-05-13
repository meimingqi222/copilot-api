function dashboardView() {
  return {
    loading: false,
    lastRefresh: null,
    data: {
      activeAccounts: 0,
      totalAccounts: 0,
      requestsToday: 0,
      errorsToday: 0,
      activeAccountQuota: null,
      totalQuota: null,
    },
    recentLogs: [],

    async load() {
      this.loading = true
      try {
        const [dashboard, recent] = await Promise.all([
          API.dashboard.get(),
          API.logs.getRecent(5),
        ])
        this.data = dashboard
        this.recentLogs = recent.entries || []
        this.lastRefresh = new Date()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    get quotaPercent() {
      const q = this.data.activeAccountQuota
      if (!q || q.unlimited || !q.premiumTotal) return 0
      return ((q.premiumRemaining || 0) / q.premiumTotal) * 100
    },

    get quotaColorClass() {
      const pct = this.quotaPercent
      if (pct < 10) return "bg-[var(--apple-red)]"
      if (pct < 25) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    get chatQuotaPercent() {
      const q = this.data.activeAccountQuota
      if (!q || !q.chatTotal) return 0
      return ((q.chatRemaining || 0) / q.chatTotal) * 100
    },

    get chatQuotaColorClass() {
      const pct = this.chatQuotaPercent
      if (pct < 10) return "bg-[var(--apple-red)]"
      if (pct < 25) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    get premiumQuotaPercent() {
      const q = this.data.activeAccountQuota
      if (!q || !q.premiumTotal) return 0
      return ((q.premiumRemaining || 0) / q.premiumTotal) * 100
    },

    get premiumQuotaColorClass() {
      const pct = this.premiumQuotaPercent
      if (pct < 10) return "bg-[var(--apple-red)]"
      if (pct < 25) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    get totalChatQuotaPercent() {
      const q = this.data.totalQuota
      if (!q || !q.chatTotal) return 0
      return ((q.chatRemaining || 0) / q.chatTotal) * 100
    },

    get totalQuotaColorClass() {
      const pct = this.totalChatQuotaPercent
      if (pct < 10) return "bg-[var(--apple-red)]"
      if (pct < 25) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    get totalPremiumPercent() {
      const q = this.data.totalQuota
      if (!q || !q.premiumTotal) return 0
      return ((q.premiumRemaining || 0) / q.premiumTotal) * 100
    },

    get totalPremiumColorClass() {
      const pct = this.totalPremiumPercent
      if (pct < 10) return "bg-[var(--apple-red)]"
      if (pct < 25) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    getLevelClass(level) {
      const map = {
        debug: "badge-info",
        info: "badge-success",
        warn: "badge-warning",
        error: "badge-danger",
      }
      return map[level] || "badge-info"
    },

    showToast(msg, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(msg, type)
    },
    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleString()
    },
    t(key, params) {
      // Access parent lang to establish reactive dependency
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },
  }
}

// Users (API Keys) View Component
