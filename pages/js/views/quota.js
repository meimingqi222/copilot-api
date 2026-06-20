function quotaView() {
  return {
    loading: false,
    refreshing: false,
    refreshingAccountId: null,
    accounts: [],
    users: [],
    dateRange: "today",
    selectedMonth: "", // YYYY-MM, set when dateRange === "custom"
    showPricingModal: false,
    modelPrices: {},
    usageSummary: {
      totals: {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
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
      // Patch Chart.js bug #11743: destroy() doesn't cancel pending rAF,
      // so clear/draw can fire on a null canvas after destroy.
      // This only needs to run once.
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

      // Initial load
      this.load()
      // Reload when view becomes active (switched back to quota)
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "quota") {
            this.load()
          } else {
            // Destroy chart when leaving quota view to prevent canvas errors
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

    async load() {
      this.loading = true
      try {
        const data = await API.quota.get()
        this.accounts = data.accounts || []
        this.users = data.users || []
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
        // Convert from $/1K to $/1M for display (multiply by 1000)
        this.modelPrices = {}
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

    async saveModelPricing(model) {
      try {
        const price = this.modelPrices[model]
        // Convert from $/1M to $/1K for storage (divide by 1000)
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
        this.showToast("模型价格已保存", "success")
      } catch (e) {
        this.showToast("保存失败：" + e.message, "error")
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
      }
    },

    renderChart() {
      // Increment token so any pending retries from a previous call become stale
      const token = ++this.chartRenderToken

      if (typeof Chart === "undefined") return

      const attempt = (retryCount = 0) => {
        // Bail out if a newer renderChart() call has started
        if (token !== this.chartRenderToken) return

        const canvas = document.querySelector("#usageTrendChart")
        // Check that canvas exists AND is actually visible (offsetParent is null
        // when the element or any ancestor has display:none)
        if (!canvas || canvas.offsetParent === null) {
          if (retryCount < 30) {
            setTimeout(() => attempt(retryCount + 1), 150)
          }
          return
        }

        // Destroy existing chart but do NOT replace the canvas element.
        // Replacing the canvas causes Chart.js's internal rAF callbacks to
        // hold a stale reference → "Cannot read properties of null (reading 'getContext')".
        if (this.usageChart) {
          this.usageChart.destroy()
          this.usageChart = null
        }

        const ctx = canvas.getContext("2d")
        if (!ctx) return

        const intervalSeries = this.usageSummary.intervalSeries || []
        const timeSeries = this.usageSummary.timeSeries || []

        // Server returns intervalSeries only when range is a single day
        const useInterval = intervalSeries.length > 0
        const hasDailyData = timeSeries.length > 0
        if (!useInterval && !hasDailyData) return

        // Get CSS variables for colors
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
          // 15-min slots: sort by slotTs, format as HH:MM
          sortedData = [...intervalSeries].sort((a, b) => a.slotTs - b.slotTs)
          labels = sortedData.map((d) => {
            const date = new Date(d.slotTs)
            const hh = String(date.getHours()).padStart(2, "0")
            const mm = String(date.getMinutes()).padStart(2, "0")
            return `${hh}:${mm}`
          })
        } else {
          // Daily: sort by date ascending
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
            label: this.t("quota.tokens.total"),
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

    getModelShare(tokens) {
      const totalTokens = this.usageSummary?.totals?.totalTokens || 0
      if (!totalTokens) return 0
      return Math.min(tokens / totalTokens, 1)
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

    isOAuthQuotaProvider(provider) {
      return QuotaDisplay.isOAuthProvider(provider)
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

    formatQuotaSummary(account) {
      return QuotaDisplay.formatSummary(account, (key, params) =>
        this.t(key, params),
      )
    },

    calculatePercent(remaining, total) {
      if (!total) return 0
      return Math.min(((total - (remaining || 0)) / total) * 100, 100)
    },

    getUsageColor(remaining, limit) {
      if (!limit) return "bg-[var(--apple-green)]"
      const pct = (remaining || 0) / limit
      if (pct < 0.2) return "bg-[var(--apple-red)]"
      if (pct < 0.5) return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-green)]"
    },

    formatPercent(value) {
      return (value * 100).toFixed(1) + "%"
    },

    // Format token count with appropriate unit (K, M, or raw)
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
      // Access parent lang to establish reactive dependency
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },
  }
}

// Guard View Component
