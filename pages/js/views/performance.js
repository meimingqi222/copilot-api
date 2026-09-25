function performanceView() {
  return {
    ...ViewHelpers,
    loading: false,
    dateRange: "today",
    selectedMonth: "",
    performance: [],
    byProvider: [],
    providerFilter: "all",
    period: { startDate: "", endDate: "" },

    init() {
      this.load()
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "performance") {
            this.load()
          }
        })
      }
    },

    setRange(range) {
      this.dateRange = range
      if (range !== "custom") {
        this.selectedMonth = ""
      }
      this.loadPerformance().catch(() => {
        this.showToast(this.t("error.load"), "error")
      })
    },

    setMonth(month) {
      if (!month) return
      this.dateRange = "custom"
      this.selectedMonth = month
      this.loadPerformance().catch(() => {
        this.showToast(this.t("error.load"), "error")
      })
    },

    async load() {
      this.loading = true
      try {
        await this.loadPerformance()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadPerformance() {
      try {
        const params =
          this.dateRange === "custom" && this.selectedMonth ?
            { month: this.selectedMonth }
          : { range: this.dateRange }
        const data = await API.usage.performance(params)
        this.performance = data.performance || []
        this.byProvider = data.byProvider || []
        // 当前筛选的 provider 无数据时回退到全部
        if (
          this.providerFilter !== "all"
          && !this.byProvider.some((r) => r.provider === this.providerFilter)
        ) {
          this.providerFilter = "all"
        }
        this.period = data.period || { startDate: "", endDate: "" }
      } catch (e) {
        console.error("Failed to load performance data:", e)
        // Never leave the previous range's rows on screen under the newly
        // selected range's highlight: `range=all` can exceed the raw-row cap
        // and return 413, which would otherwise show stale numbers as if they
        // belonged to the new period. Clear so the empty state shows instead.
        this.performance = []
        this.byProvider = []
        this.period = { startDate: "", endDate: "" }
        throw e
      }
    },

    get providerOptions() {
      const seen = new Map()
      for (const row of this.byProvider || []) {
        if (!seen.has(row.provider)) {
          seen.set(row.provider, row.providerLabel || row.provider)
        }
      }
      return [...seen.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, label]) => ({ provider, label }))
    },

    get filteredByProvider() {
      if (this.providerFilter === "all") return this.byProvider || []
      return (this.byProvider || []).filter(
        (row) => row.provider === this.providerFilter,
      )
    },

    formatMs(ms) {
      if (ms === null || ms === undefined) return "-"
      if (ms >= 1000) {
        return (ms / 1000).toFixed(1) + "s"
      }
      return Math.round(ms) + "ms"
    },

    formatTps(tps) {
      if (tps === null || tps === undefined) return "-"
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
      }).format(tps)
    },

    getTtftClass(ms) {
      if (ms === null || ms === undefined) return ""
      if (ms < 500) return "text-[var(--apple-green)]"
      if (ms < 1000) return "text-[var(--apple-orange)]"
      return "text-[var(--apple-red)]"
    },

    getTpsClass(tps) {
      if (tps === null || tps === undefined) return ""
      if (tps >= 50) return "text-[var(--apple-green)]"
      if (tps >= 20) return "text-[var(--apple-orange)]"
      return ""
    },
  }
}
