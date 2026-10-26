function logsView() {
  return {
    ...ViewHelpers,
    loading: false,
    /** Monotonic id of the newest load; stale responses must not overwrite. */
    loadVersion: 0,
    /** "requests" | "system" | "status"; the last two are systemLogsView's. */
    logTab: "requests",
    entries: [],
    total: 0,
    selectedLog: null,
    /** Lazily fetched bodies for the selected request (never in the list). */
    bodies: null,
    bodiesLoading: false,
    bodiesVersion: 0,
    bodiesError: null,
    autoRefresh: false,
    refreshTimer: null,
    filters: {
      level: "",
      apiKind: "",
      outcome: "",
      search: "",
      modelMismatch: "",
      limit: 50,
      offset: 0,
    },

    init() {
      // A trace row can jump here before this view has ever mounted; it leaves
      // the request id on globalThis because its event has no listener yet.
      const pending = globalThis.__inspectRequestId
      if (pending) {
        globalThis.__inspectRequestId = undefined
        this.applyInspectRequest(pending)
      }
      globalThis.addEventListener("admin:inspect-errors", () => {
        this.filters.outcome = "failed"
        this.filters.level = ""
        this.filters.apiKind = ""
        this.filters.search = ""
        this.filters.modelMismatch = ""
        this.filters.offset = 0
        this.load()
      })
      // From a system log line: the request it was written while serving.
      globalThis.addEventListener("admin:inspect-request", (event) => {
        this.applyInspectRequest(event.detail)
      })
      this.$watch("autoRefresh", (enabled) => {
        if (enabled) {
          this.startAutoRefresh()
        } else {
          this.stopAutoRefresh()
        }
      })
      this.$watch("currentView", (view) => {
        this.stopAutoRefresh()
        if (view === "logs" && this.autoRefresh) this.startAutoRefresh()
      })
    },

    applyInspectRequest(requestId) {
      this.logTab = "requests"
      this.filters = { ...this.blankFilters(), requestId }
      this.load()
    },

    startAutoRefresh() {
      this.stopAutoRefresh()
      this.refreshTimer = setInterval(() => {
        if (this.currentView === "logs" && !document.hidden && !this.loading) {
          this.load()
        }
      }, 5000)
    },

    stopAutoRefresh() {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = null
      }
    },

    destroy() {
      this.stopAutoRefresh()
    },

    async load() {
      const version = ++this.loadVersion
      this.loading = true
      try {
        const data = await API.logs.get(this.filters)
        // A filter/page change while this response was in flight must win:
        // applying the older payload left the table and the page counter
        // describing different queries until the next interaction.
        if (version !== this.loadVersion) return
        this.entries = data.entries || []
        this.total = data.total || 0
        if (this.selectedLog) {
          this.selectedLog =
            this.entries.find(
              (entry) => entry.requestId === this.selectedLog.requestId,
            ) ?? null
          if (!this.selectedLog) {
            this.resetBodies()
          }
        }
      } catch {
        if (version === this.loadVersion) {
          this.showToast(I18n.t("error.load"), "error")
        }
      } finally {
        if (version === this.loadVersion) {
          this.loading = false
          this.$nextTick(() => refreshAdminIcons(this.$el))
        }
      }
    },

    blankFilters() {
      return {
        level: "",
        apiKind: "",
        outcome: "",
        search: "",
        modelMismatch: "",
        requestId: "",
        limit: 50,
        offset: 0,
      }
    },

    resetBodies() {
      this.bodiesVersion++
      this.bodies = null
      this.bodiesError = null
      this.bodiesLoading = false
    },

    selectLog(log) {
      this.resetBodies()
      this.selectedLog =
        this.selectedLog?.requestId === log.requestId ? null : log
    },

    async loadBodies() {
      const requestId = this.selectedLog?.requestId
      if (!requestId || this.bodiesLoading) return
      const version = ++this.bodiesVersion
      this.bodiesLoading = true
      this.bodiesError = null
      try {
        const bodies = await API.logs.bodies(requestId)
        if (version === this.bodiesVersion) this.bodies = bodies
      } catch (error) {
        if (version === this.bodiesVersion) {
          this.bodiesError = error?.message || I18n.t("logs.bodies.failed")
        }
      } finally {
        if (version === this.bodiesVersion) this.bodiesLoading = false
      }
    },

    downloadBodies() {
      if (!this.bodies) return
      const blob = new Blob([JSON.stringify(this.bodies, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `request-${this.bodies.requestId}.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    },

    bodyMeta(section) {
      if (!section) return ""
      const bytes = section.bytes ?? section.bodyBytes
      if (section.truncated) {
        return this.t("logs.bodies.truncated", { bytes: bytes ?? "?" })
      }
      return bytes === undefined ? "" : `${bytes} B`
    },

    clearFilters() {
      this.filters = this.blankFilters()
      this.load()
    },

    async exportLogs() {
      try {
        // The page size is a view concern; exporting it would silently cap the
        // download at the current page (the default was 50 rows).
        const { limit: _limit, offset: _offset, ...filters } = this.filters
        const exportLimit = 5000
        const response = await API.logs.exportLogs({
          ...filters,
          limit: exportLimit,
        })
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
        const text = await blob.text()
        const rows = text ? text.split("\n").filter(Boolean).length : 0
        if (rows >= exportLimit) {
          this.showToast(
            I18n.t("logs.exportTruncated", { limit: exportLimit }),
            "info",
          )
        }
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
