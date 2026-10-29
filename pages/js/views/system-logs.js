/**
 * 日志与诊断 view: the "System logs" and "Runtime status" tabs and the
 * diagnostic bundle dialog. Nested in logsView(), whose `logTab` it reads.
 */
function systemLogsView() {
  return {
    ...ViewHelpers,
    entries: [],
    more: false,
    loading: false,
    expanded: null,
    live: false,
    source: null,
    filters: {
      level: "",
      sub: "",
      q: "",
      req: "",
      conn: "",
      connName: "",
      job: "",
      run: "",
    },
    selectedConnection: null,
    subsystems: [
      "app",
      "quota",
      "auth",
      "connection",
      "models",
      "dispatch",
      "cli",
      "zcode",
    ],
    status: null,
    statusLoading: false,
    bundle: {
      open: false,
      sinceHours: 24,
      requests: "failed",
      sections: {
        runtime: true,
        config: true,
        connections: true,
        jobs: true,
        systemLogs: true,
        requests: true,
      },
      preview: null,
      busy: false,
      error: "",
    },

    init() {
      this.$watch("logTab", (tab) => this.enterTab(tab))
      this.$watch("currentView", (view) => {
        if (view !== "logs") this.stopLive()
      })
    },

    enterTab(tab) {
      if (tab === "system") void this.load()
      else this.stopLive()
      if (tab === "status") void this.loadStatus()
    },

    /** From a request's detail: show what was logged while serving it. */
    showRequest(requestId) {
      this.showFiltered({ req: requestId })
    },

    /** From a job row: show the lines of its failed run. */
    showRun(job, run) {
      this.showFiltered({ job, run: run || "" })
    },

    /** From a connection row: show what was logged about it. */
    showConnection(conn) {
      const connection = this.status?.connections?.find(
        (item) => item.id === conn,
      )
      this.showFiltered({ conn, connName: connection?.name || "" })
      this.selectedConnection = connection || null
    },

    showFiltered(filters) {
      this.selectedConnection = null
      this.filters = { ...this.emptyFilters(), ...filters }
      // Switching tabs loads; on the tab already, load here.
      if (this.logTab === "system") void this.load()
      else this.logTab = "system"
      this.$nextTick(() =>
        this.$refs.systemLogPanel.scrollIntoView({ block: "start" }),
      )
    },

    emptyFilters() {
      return {
        level: "",
        sub: "",
        q: "",
        req: "",
        conn: "",
        connName: "",
        job: "",
        run: "",
      }
    },

    clearFilters() {
      this.selectedConnection = null
      this.filters = this.emptyFilters()
      void this.load()
    },

    async load(older = false) {
      this.loading = true
      try {
        const before = older ? this.entries.at(-1)?.ts : undefined
        const data = await API.systemLogs.get({
          ...this.filters,
          before,
          limit: 200,
        })
        this.entries =
          older ?
            [...this.entries, ...(data.entries || [])]
          : data.entries || []
        this.more = Boolean(data.more)
        if (this.live) this.startLive()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
      }
    },

    toggleLive() {
      if (this.live) this.stopLive()
      else this.startLive()
    },

    startLive() {
      this.stopLive()
      this.live = true
      const source = new EventSource(API.systemLogs.streamUrl(this.filters))
      const seen = new Set(
        this.entries.map((entry) => `${entry.ts}:${entry.id}`),
      )
      source.addEventListener("log", (event) => {
        try {
          const entry = JSON.parse(event.data)
          const key = `${entry.ts}:${entry.id}`
          if (seen.has(key)) return
          seen.add(key)
          this.entries.unshift(entry)
          if (this.entries.length > 2000) this.entries.length = 2000
        } catch {
          // A malformed frame is skipped.
        }
      })
      this.source = source
    },

    stopLive() {
      this.source?.close()
      this.source = null
      this.live = false
    },

    destroy() {
      this.stopLive()
    },

    async exportLogs() {
      try {
        const response = await API.systemLogs.exportLogs({
          ...this.filters,
          limit: 20000,
        })
        await this.saveResponse(response, "system-logs.jsonl")
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      }
    },

    async saveResponse(response, fallback) {
      const blob = await response.blob()
      const disposition = response.headers.get("content-disposition") || ""
      const match = disposition.match(/filename="?([^"]+)"?/)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = match ? match[1] : fallback
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    },

    levelClass(level) {
      if (level === "error" || level === "fatal") return "badge-danger"
      if (level === "warn") return "badge-warning"
      if (level === "info") return "badge-success"
      return "badge-info"
    },

    formatTs(ts) {
      const date = new Date(ts)
      return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString()
    },

    formatAgo(ts) {
      if (!ts) return "-"
      const seconds = Math.round((Date.now() - ts) / 1000)
      if (seconds < 0)
        return `${I18n.t("logs.status.in")} ${this.formatSpan(-seconds)}`
      return `${this.formatSpan(seconds)} ${I18n.t("logs.status.ago")}`
    },

    formatSpan(seconds) {
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
      return `${Math.round(seconds / 86400)}d`
    },

    formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "-"
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    },

    async loadStatus() {
      this.statusLoading = true
      try {
        this.status = await API.diagnostics.status()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.statusLoading = false
      }
    },

    /** Jobs that failed last time first, then the busiest. */
    get jobs() {
      const rank = { error: 0, warn: 1 }
      return [...(this.status?.jobs || [])].sort(
        (a, b) =>
          (rank[a.lastOutcome] ?? 2) - (rank[b.lastOutcome] ?? 2)
          || (b.lastStartAt ?? 0) - (a.lastStartAt ?? 0),
      )
    },

    get troubledConnections() {
      return (this.status?.connections || []).filter((connection) =>
        connection.credentials.some(
          (credential) => credential.status !== "ready" || credential.lastError,
        ),
      )
    },

    openBundle() {
      this.bundle.open = true
      this.bundle.error = ""
      void this.previewBundle()
    },

    bundleOptions() {
      return {
        sinceHours: Number(this.bundle.sinceHours),
        requests: this.bundle.requests,
        sections: Object.entries(this.bundle.sections)
          .filter(([, on]) => on)
          .map(([name]) => name),
      }
    },

    async previewBundle() {
      this.bundle.preview = null
      if (this.bundleOptions().sections.length === 0) return
      this.bundle.busy = true
      try {
        this.bundle.preview = await API.diagnostics.preview(
          this.bundleOptions(),
        )
      } catch (error) {
        this.bundle.error = String(error?.message || error)
      } finally {
        this.bundle.busy = false
      }
    },

    async downloadBundle() {
      this.bundle.busy = true
      this.bundle.error = ""
      try {
        const response = await API.diagnostics.download(this.bundleOptions())
        await this.saveResponse(response, "copilot-api-diagnostics.json.gz")
        this.bundle.open = false
      } catch (error) {
        this.bundle.error = String(error?.message || error)
      } finally {
        this.bundle.busy = false
      }
    },
  }
}
