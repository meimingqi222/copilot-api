function logsView() {
  return {
    ...ViewHelpers,
    loading: false,
    entries: [],
    total: 0,
    selectedLog: null,
    autoRefresh: false,
    refreshTimer: null,
    filters: {
      level: "",
      apiKind: "",
      outcome: "",
      search: "",
      limit: 50,
      offset: 0,
    },

    init() {
      this.$watch("autoRefresh", (enabled) => {
        if (enabled) {
          this.startAutoRefresh()
        } else {
          this.stopAutoRefresh()
        }
      })
    },

    startAutoRefresh() {
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
        if (this.selectedLog) {
          this.selectedLog =
            this.entries.find(
              (entry) => entry.requestId === this.selectedLog.requestId,
            ) ?? null
        }
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    clearFilters() {
      this.filters = {
        level: "",
        apiKind: "",
        outcome: "",
        search: "",
        limit: 50,
        offset: 0,
      }
      this.load()
    },

    async exportLogs() {
      try {
        const response = await API.logs.exportLogs(this.filters)
        const blob = await response.blob()
        const disposition = response.headers.get("content-disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename = match ? match[1] : "copilot-api-logs.jsonl"
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = filename
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      } catch {
        this.showToast(I18n.t("error.load"), "error")
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

    formatJson(value) {
      return JSON.stringify(value ?? null, null, 2)
    },

    formatUpstream(log) {
      if (!log) return "-"
      if (log.connectionName) {
        const connection =
          log.provider && log.provider !== log.connectionName ?
            `${log.provider}/${log.connectionName}`
          : log.connectionName
        return log.credentialLabel ?
            `${connection} · ${log.credentialLabel}`
          : connection
      }
      return log.finalTarget || log.connectionId || log.provider || "-"
    },

    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleString()
    },
  }
}
