function logsView() {
  return {
    loading: false,
    entries: [],
    total: 0,
    autoRefresh: false,
    refreshTimer: null,
    filters: { level: "", search: "", limit: 50, offset: 0 },

    init() {
      // Watch autoRefresh and start/stop timer accordingly
      this.$watch("autoRefresh", (enabled) => {
        if (enabled) {
          this.startAutoRefresh()
        } else {
          this.stopAutoRefresh()
        }
      })
    },

    startAutoRefresh() {
      // Refresh every 5 seconds when auto-refresh is enabled
      this.refreshTimer = setInterval(() => {
        this.load()
      }, 5000)
    },

    stopAutoRefresh() {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = null
      }
    },

    async load() {
      this.loading = true
      try {
        const data = await API.logs.get(this.filters)
        this.entries = data.entries || []
        this.total = data.total || 0
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    prevPage() {
      if (this.filters.offset >= this.filters.limit) {
        this.filters.offset -= this.filters.limit
        this.load()
      }
    },

    nextPage() {
      if (this.filters.offset + this.filters.limit < this.total) {
        this.filters.offset += this.filters.limit
        this.load()
      }
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
