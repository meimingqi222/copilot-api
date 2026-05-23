function performanceView() {
  return {
    loading: false,
    dateRange: "today",
    selectedMonth: "",
    performance: [],
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
      this.loadPerformance()
    },

    setMonth(month) {
      if (!month) return
      this.dateRange = "custom"
      this.selectedMonth = month
      this.loadPerformance()
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
        this.period = data.period || { startDate: "", endDate: "" }
      } catch (e) {
        console.error("Failed to load performance data:", e)
      }
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

    showToast(msg, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(msg, type)
    },
    t(key, params) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },
  }
}
