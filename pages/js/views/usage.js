function usageView() {
  return {
    loading: false,
    refreshing: false,
    dateRange: "today",
    selectedMonth: "",
    showPricingModal: false,
    modelPrices: {},
    pricingSources: {},
    modelViewMode: "aggregate",
    expandedAccounts: {},
    usageSummary: {
      totals: {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        cacheHitRate: null,
      },
      byAccount: {},
      byUser: {},
      byModel: {},
      timeSeries: [],
      period: { startDate: "", endDate: "" },
    },
    usageChart: null,
    chartRenderToken: 0,

    init() {
      if (typeof Chart !== "undefined" && !Chart._patchedNullCanvas) {
        Chart._patchedNullCanvas = true
        const origClear = Chart.prototype.clear
        Chart.prototype.clear = function () {
          if (!this.canvas) return this
          return origClear.call(this)
        }
        const origDraw = Chart.prototype.draw
        Chart.prototype.draw = function () {
          if (!this.canvas) return this
          return origDraw.call(this)
        }
      }

      this.load()
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "usage") {
            this.load()
          } else {
            this.destroyChart()
          }
        })
      }
    },

    destroyChart() {
      if (this.usageChart) {
        this.usageChart.destroy()
        this.usageChart = null
      }
    },

    setRange(range) {
      this.dateRange = range
      if (range !== "custom") {
        this.selectedMonth = ""
      }
      this.loadUsageStats().then(() => {
        this.$nextTick(() => this.renderChart())
      })
    },

    setMonth(month) {
      if (!month) return
      this.dateRange = "custom"
      this.selectedMonth = month
      this.loadUsageStats().then(() => {
        this.$nextTick(() => this.renderChart())
      })
    },

    setModelViewMode(mode) {
      this.modelViewMode = mode
      this.$nextTick(() => lucide.createIcons())
    },

    toggleAccountExpanded(accountId) {
      this.expandedAccounts[accountId] = !this.expandedAccounts[accountId]
      this.$nextTick(() => lucide.createIcons())
    },

    isAccountExpanded(accountId) {
      return Boolean(this.expandedAccounts[accountId])
    },

    async load() {
      this.loading = true
      try {
        await this.loadUsageStats()
        await this.loadModelPricing()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => {
          lucide.createIcons()
          this.renderChart()
        })
      }
    },

    async loadModelPricing() {
      try {
        const data = await API.usage.getPricing()
        this.modelPrices = {}
        this.pricingSources = data.sources || {}
        for (const [model, price] of Object.entries(data.pricing || {})) {
          this.modelPrices[model] = {
            promptPricePer1m: price.promptPricePer1k * 1000,
            completionPricePer1m: price.completionPricePer1k * 1000,
            cacheReadPricePer1m: price.cacheReadPricePer1k * 1000,
            cacheWritePricePer1m: price.cacheWritePricePer1k * 1000,
          }
        }
      } catch (e) {
        console.error("Failed to load model pricing:", e)
      }
    },

    isPricingUnmatched(model) {
      return this.pricingSources[model] === "unmatched"
    },

    async saveModelPricing(model) {
      try {
        const price = this.modelPrices[model]
        await API.usage.updatePricing(model, {
          promptPricePer1k:
            (Number.parseFloat(price.promptPricePer1m) || 0) / 1000,
          completionPricePer1k:
            (Number.parseFloat(price.completionPricePer1m) || 0) / 1000,
          cacheReadPricePer1k:
            (Number.parseFloat(price.cacheReadPricePer1m) || 0) / 1000,
          cacheWritePricePer1k:
            (Number.parseFloat(price.cacheWritePricePer1m) || 0) / 1000,
        })
        this.showToast(this.t("usage.pricingSaved"), "success")
      } catch (e) {
        this.showToast(this.t("usage.pricingSaveError") + e.message, "error")
      }
    },

    async loadUsageStats() {
      try {
        const params =
          this.dateRange === "custom" && this.selectedMonth ?
            { month: this.selectedMonth }
          : { range: this.dateRange }
        const data = await API.usage.summary(params)
        this.usageSummary = data
      } catch (e) {
        console.error("Failed to load usage stats:", e)
        throw e
      }
    },

    async refresh() {
      this.refreshing = true
      try {
        await this.loadUsageStats()
        await this.loadModelPricing()
        this.showToast(this.t("usage.refreshSuccess"), "success")
        this.$nextTick(() => this.renderChart())
      } catch {
        this.showToast(this.t("usage.refreshError"), "error")
      } finally {
        this.refreshing = false
      }
    },

    renderChart() {
      const token = ++this.chartRenderToken

      if (typeof Chart === "undefined") return

      const attempt = (retryCount = 0) => {
        if (token !== this.chartRenderToken) return

        const canvas = document.querySelector("#usageTrendChart")
        if (!canvas || canvas.offsetParent === null) {
          if (retryCount < 30) {
            setTimeout(() => attempt(retryCount + 1), 150)
          }
          return
        }

        if (this.usageChart) {
          this.usageChart.destroy()
          this.usageChart = null
        }

        const ctx = canvas.getContext("2d")
        if (!ctx) return

        const intervalSeries = this.usageSummary.intervalSeries || []
        const timeSeries = this.usageSummary.timeSeries || []

        const useInterval = intervalSeries.length > 0
        const hasDailyData = timeSeries.length > 0
        if (!useInterval && !hasDailyData) return

        const root = getComputedStyle(document.documentElement)
        const blueColor =
          root.getPropertyValue("--apple-blue")?.trim() || "#007AFF"
        const greenColor =
          root.getPropertyValue("--apple-green")?.trim() || "#34C759"
        const orangeColor =
          root.getPropertyValue("--apple-orange")?.trim() || "#FF9500"
        const purpleColor =
          root.getPropertyValue("--apple-purple")?.trim() || "#AF52DE"
        const pinkColor =
          root.getPropertyValue("--apple-pink")?.trim() || "#FF2D55"
        const redColor =
          root.getPropertyValue("--apple-red")?.trim() || "#FF3B30"
        const textColor =
          root.getPropertyValue("--apple-text")?.trim() || "#1D1D1F"
        const textSecondaryColor =
          root.getPropertyValue("--apple-text-secondary")?.trim() || "#86868B"
        const palette = [
          blueColor,
          greenColor,
          orangeColor,
          purpleColor,
          pinkColor,
          redColor,
        ]

        let labels, sortedData
        if (useInterval) {
          sortedData = [...intervalSeries].sort((a, b) => a.slotTs - b.slotTs)
          labels = sortedData.map((d) => {
            const date = new Date(d.slotTs)
            const hh = String(date.getHours()).padStart(2, "0")
            const mm = String(date.getMinutes()).padStart(2, "0")
            return `${hh}:${mm}`
          })
        } else {
          sortedData = [...timeSeries].sort((a, b) =>
            a.date.localeCompare(b.date),
          )
          labels = sortedData.map((d) => {
            const parts = d.date.split("-")
            return `${Number.parseInt(parts[1], 10)}/${Number.parseInt(parts[2], 10)}`
          })
        }

        const datasets = [
          {
            label: this.t("usage.tokens.total"),
            data: sortedData.map((d) => d.totalTokens),
            borderColor: blueColor,
            backgroundColor: blueColor + "20",
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
        ]

        for (const [index, [model]] of this.sortedModelUsage.entries()) {
          const color = palette[index % palette.length]
          datasets.push({
            label: model,
            data: sortedData.map((d) => d.models?.[model]?.totalTokens || 0),
            borderColor: color,
            backgroundColor: "transparent",
            fill: false,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 4,
            borderWidth: 2,
          })
        }

        this.usageChart = new Chart(ctx, {
          type: "line",
          data: { labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: {
                position: "top",
                labels: {
                  color: textColor,
                  usePointStyle: true,
                  padding: 16,
                  boxWidth: 10,
                  boxHeight: 10,
                },
              },
              tooltip: {
                backgroundColor: "rgba(0,0,0,0.82)",
                titleColor: "#fff",
                bodyColor: "#fff",
                padding: 12,
                cornerRadius: 10,
                callbacks: {
                  label: (context) => {
                    let label = context.dataset.label || ""
                    if (label) label += ": "
                    label += this.formatTokens(context.raw || 0)
                    return label
                  },
                },
              },
            },
            scales: {
              x: {
                ticks: { color: textSecondaryColor },
                grid: { color: "rgba(0,0,0,0.05)" },
              },
              y: {
                type: "linear",
                display: true,
                position: "left",
                ticks: {
                  color: textSecondaryColor,
                  callback: (value) => this.formatTokens(value),
                },
                grid: { color: "rgba(0,0,0,0.05)" },
              },
            },
          },
        })
      }
      attempt()
    },

    get sortedModelUsage() {
      return Object.entries(this.usageSummary.byModel || {}).sort(
        ([, left], [, right]) => {
          return (right.totalTokens || 0) - (left.totalTokens || 0)
        },
      )
    },

    get sortedAccountUsage() {
      return Object.entries(this.usageSummary.byAccount || {})
        .filter(([, data]) => (data.requests || 0) > 0)
        .sort(([, left], [, right]) => {
          return (right.totalTokens || 0) - (left.totalTokens || 0)
        })
    },

    sortedAccountModels(models) {
      return Object.entries(models || {}).sort(([, left], [, right]) => {
        return (right.totalTokens || 0) - (left.totalTokens || 0)
      })
    },

    getModelShare(tokens) {
      const totalTokens = this.usageSummary?.totals?.totalTokens || 0
      if (!totalTokens) return 0
      return Math.min(tokens / totalTokens, 1)
    },

    formatPercent(value) {
      return (value * 100).toFixed(1) + "%"
    },

    formatCacheHitRate(rate) {
      if (rate === null || rate === undefined) return "—"
      return this.formatPercent(rate)
    },

    getCacheHitRateClass(rate) {
      if (rate === null || rate === undefined) {
        return "text-[var(--apple-text-tertiary)]"
      }
      if (rate >= 0.5) return "text-[var(--apple-green)]"
      if (rate >= 0.2) return "text-[var(--apple-blue)]"
      return "text-[var(--apple-orange)]"
    },

    formatTokens(tokens) {
      const numericTokens = Number(tokens || 0)
      if (numericTokens === 0) return "0"
      if (numericTokens >= 1000000) {
        return (numericTokens / 1000000).toFixed(1) + "M"
      }
      if (numericTokens >= 1000) {
        return (numericTokens / 1000).toFixed(1) + "K"
      }
      return numericTokens.toString()
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
