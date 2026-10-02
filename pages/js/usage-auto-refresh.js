function usageAutoRefresh(viewName) {
  return {
    autoRefreshSeconds: 5,
    lastUpdatedAt: 0,
    autoRefreshTimer: null,
    autoRefreshBusy: false,
    autoRefreshDue: 0,
    autoRefreshVisibilityHandler: null,

    initAutoRefresh() {
      if (this.autoRefreshTimer !== null) return
      try {
        const saved = Number(
          localStorage.getItem(`copilot.${viewName}Refresh`) ?? 5,
        )
        if ([0, 5, 10, 30, 60].includes(saved)) this.autoRefreshSeconds = saved
      } catch (error) {
        console.warn("Could not read refresh preference", error)
      }
      this.autoRefreshVisibilityHandler = () => {
        if (!document.hidden) {
          this.autoRefreshDue = 0
          void this.pollUsageView()
        }
      }
      document.addEventListener(
        "visibilitychange",
        this.autoRefreshVisibilityHandler,
      )
      this.autoRefreshTimer = setInterval(() => void this.pollUsageView(), 1000)
    },

    setAutoRefresh(value) {
      const seconds = Number(value)
      if (![0, 5, 10, 30, 60].includes(seconds)) return
      this.autoRefreshSeconds = seconds
      this.autoRefreshDue = 0
      try {
        localStorage.setItem(`copilot.${viewName}Refresh`, String(seconds))
      } catch (error) {
        console.warn("Could not save refresh preference", error)
      }
    },

    async pollUsageView() {
      const app = document.querySelector("[x-data^=adminApp]")
      if (
        !this.autoRefreshSeconds
        || document.hidden
        || !app
        || Alpine.$data(app).currentView !== viewName
        || this.loading
        || this.refreshing
        || this.autoRefreshBusy
        || this.showPricingModal
        || this.refreshingAccountId
        || this.resettingAccountId
        || Date.now() < this.autoRefreshDue
      )
        return
      this.autoRefreshBusy = true
      try {
        await this.refreshCachedUsage()
      } catch (error) {
        console.warn("Automatic usage refresh failed", error)
      } finally {
        this.autoRefreshBusy = false
        this.autoRefreshDue = Date.now() + this.autoRefreshSeconds * 1000
      }
    },

    updatedTime() {
      return this.lastUpdatedAt ?
          new Date(this.lastUpdatedAt).toLocaleTimeString()
        : "—"
    },

    destroy() {
      clearInterval(this.autoRefreshTimer)
      document.removeEventListener(
        "visibilitychange",
        this.autoRefreshVisibilityHandler,
      )
      this.destroyChart?.()
      this.autoRefreshTimer = null
    },
  }
}
