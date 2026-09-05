function usageView() {
  return {
    ...ViewHelpers,
    loading: false,
    refreshing: false,
    dateRange: "today",
    selectedMonth: "",
    showPricingModal: false,
    modelPrices: {},
    pricingSources: {},
    modelViewMode: "aggregate",
    modelSearch: "",
    showAllModels: false,
    modelTopN: 10,
    expandedAccounts: {},
    expandedProviders: {},
    expandedProviderAccounts: {},
    customStartDate: "",
    customEndDate: "",
    monthPickerOpen: false,
    customRangeOpen: false,
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
      byProvider: {},
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
        this.customStartDate = ""
        this.customEndDate = ""
        this.monthPickerOpen = false
        this.customRangeOpen = false
      }
      this.loadUsageStats()
        .then(() => {
          this.$nextTick(() => this.renderChart())
        })
        .catch(() => {
          this.showToast(this.t("error.load"), "error")
        })
    },

    // Value bound to the quick-range <select>; blank when a custom date
    // range is active (no single option represents it).
    get quickSelectValue() {
      if (this.monthPickerOpen || this.selectedMonth) return "pickMonth"
      return this.dateRange === "custom" ? "" : this.dateRange
    },

    onQuickSelect(value) {
      // 空值表示当前是自定义周期占位 option,不做任何操作
      // (用户点击 select 但没有切换到其他快速选项)
      if (!value) return
      if (value === "pickMonth") {
        this.monthPickerOpen = true
        this.customRangeOpen = false
        this.customStartDate = ""
        this.customEndDate = ""
        return
      }
      this.monthPickerOpen = false
      this.customRangeOpen = false
      this.setRange(value)
    },

    toggleCustomRange() {
      this.customRangeOpen = !this.customRangeOpen
      if (this.customRangeOpen) {
        this.monthPickerOpen = false
        this.selectedMonth = ""
      }
    },

    // Bind flatpickr's range mode to a single input so start/end are picked
    // together in one calendar instead of two disconnected date fields.
    initCustomRangePicker(el) {
      flatpickr(el, {
        mode: "range",
        dateFormat: "Y-m-d",
        locale: I18n.currentLang() === "zh" ? "zh" : "default",
        // Show two months side by side (like Ant Design's RangePicker) so
        // cross-month ranges don't require flipping calendar pages.
        showMonths: window.innerWidth < 640 ? 1 : 2,
        maxDate: this.todayStr,
        defaultDate:
          this.customStartDate && this.customEndDate ?
            [this.customStartDate, this.customEndDate]
          : undefined,
        onChange: (selectedDates, _dateStr, instance) => {
          if (selectedDates.length !== 2) return
          this.customStartDate = instance.formatDate(selectedDates[0], "Y-m-d")
          this.customEndDate = instance.formatDate(selectedDates[1], "Y-m-d")
          this.setCustomRange()
        },
      })
    },

    setMonth(month) {
      if (!month) return
      this.dateRange = "custom"
      this.selectedMonth = month
      this.customStartDate = ""
      this.customEndDate = ""
      this.customRangeOpen = false
      this.loadUsageStats()
        .then(() => {
          this.$nextTick(() => this.renderChart())
        })
        .catch(() => {
          this.showToast(this.t("error.load"), "error")
        })
    },

    setModelViewMode(mode) {
      this.modelViewMode = mode
      this.showAllModels = false
      this.$nextTick(() => lucide.createIcons())
    },

    toggleShowAllModels() {
      this.showAllModels = !this.showAllModels
      this.$nextTick(() => lucide.createIcons())
    },

    get filteredModelUsage() {
      const q = (this.modelSearch || "").trim().toLowerCase()
      if (!q) return this.sortedModelUsage
      return this.sortedModelUsage.filter(([model]) =>
        model.toLowerCase().includes(q),
      )
    },

    get displayedModelUsage() {
      if (this.showAllModels) return this.filteredModelUsage
      return this.filteredModelUsage.slice(0, this.modelTopN)
    },

    get sortedUserUsage() {
      return Object.entries(this.usageSummary.byUser || {}).sort(
        ([, left], [, right]) => {
          return (right.totalTokens || 0) - (left.totalTokens || 0)
        },
      )
    },

    toggleAccountExpanded(accountId) {
      this.expandedAccounts[accountId] = !this.expandedAccounts[accountId]
      this.$nextTick(() => lucide.createIcons())
    },

    isAccountExpanded(accountId) {
      return Boolean(this.expandedAccounts[accountId])
    },

    toggleProviderExpanded(providerId) {
      this.expandedProviders[providerId] = !this.expandedProviders[providerId]
      this.$nextTick(() => lucide.createIcons())
    },

    isProviderExpanded(providerId) {
      return Boolean(this.expandedProviders[providerId])
    },

    toggleProviderAccountExpanded(providerId, accountId) {
      if (!this.expandedProviderAccounts[providerId]) {
        this.expandedProviderAccounts[providerId] = {}
      }
      this.expandedProviderAccounts[providerId][accountId] =
        !this.expandedProviderAccounts[providerId][accountId]
      this.$nextTick(() => lucide.createIcons())
    },

    isProviderAccountExpanded(providerId, accountId) {
      return Boolean(this.expandedProviderAccounts[providerId]?.[accountId])
    },

    get todayStr() {
      const d = new Date()
      const m = String(d.getMonth() + 1).padStart(2, "0")
      const day = String(d.getDate()).padStart(2, "0")
      return `${d.getFullYear()}-${m}-${day}`
    },

    setCustomRange() {
      if (!this.customStartDate || !this.customEndDate) return
      if (this.customStartDate > this.customEndDate) return
      this.dateRange = "custom"
      this.selectedMonth = ""
      this.monthPickerOpen = false
      this.loadUsageStats()
        .then(() => {
          this.$nextTick(() => this.renderChart())
        })
        .catch(() => {
          this.showToast(this.t("error.load"), "error")
        })
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
            contextThresholdTokens: price.contextThresholdTokens ?? "",
            extendedPromptPricePer1m:
              (
                price.extendedPromptPricePer1k !== null
                && price.extendedPromptPricePer1k !== undefined
              ) ?
                price.extendedPromptPricePer1k * 1000
              : "",
            extendedCompletionPricePer1m:
              (
                price.extendedCompletionPricePer1k !== null
                && price.extendedCompletionPricePer1k !== undefined
              ) ?
                price.extendedCompletionPricePer1k * 1000
              : "",
            extendedCacheReadPricePer1m:
              (
                price.extendedCacheReadPricePer1k !== null
                && price.extendedCacheReadPricePer1k !== undefined
              ) ?
                price.extendedCacheReadPricePer1k * 1000
              : "",
            extendedCacheWritePricePer1m:
              (
                price.extendedCacheWritePricePer1k !== null
                && price.extendedCacheWritePricePer1k !== undefined
              ) ?
                price.extendedCacheWritePricePer1k * 1000
              : "",
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
        const toPer1k = (v) => {
          if (v === "" || v === null || v === undefined) return null
          const n = Number.parseFloat(v)
          return Number.isFinite(n) ? n / 1000 : null
        }
        const toThreshold = (v) => {
          if (v === "" || v === null || v === undefined) return null
          const n = Number.parseInt(v, 10)
          return Number.isFinite(n) && n > 0 ? n : null
        }
        await API.usage.updatePricing(model, {
          promptPricePer1k:
            (Number.parseFloat(price.promptPricePer1m) || 0) / 1000,
          completionPricePer1k:
            (Number.parseFloat(price.completionPricePer1m) || 0) / 1000,
          cacheReadPricePer1k:
            (Number.parseFloat(price.cacheReadPricePer1m) || 0) / 1000,
          cacheWritePricePer1k:
            (Number.parseFloat(price.cacheWritePricePer1m) || 0) / 1000,
          contextThresholdTokens: toThreshold(price.contextThresholdTokens),
          extendedPromptPricePer1k: toPer1k(price.extendedPromptPricePer1m),
          extendedCompletionPricePer1k: toPer1k(
            price.extendedCompletionPricePer1m,
          ),
          extendedCacheReadPricePer1k: toPer1k(
            price.extendedCacheReadPricePer1m,
          ),
          extendedCacheWritePricePer1k: toPer1k(
            price.extendedCacheWritePricePer1m,
          ),
        })
        this.showToast(this.t("usage.pricingSaved"), "success")
      } catch (e) {
        this.showToast(this.t("usage.pricingSaveError") + e.message, "error")
      }
    },

    async loadUsageStats() {
      try {
        let params
        if (this.dateRange === "custom") {
          if (this.selectedMonth) {
            params = { month: this.selectedMonth }
          } else if (this.customStartDate && this.customEndDate) {
            params = {
              startDate: this.customStartDate,
              endDate: this.customEndDate,
            }
          } else {
            params = { range: "today" }
          }
        } else {
          params = { range: this.dateRange }
        }
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

    get sortedProviderUsage() {
      return Object.entries(this.usageSummary.byProvider || {})
        .filter(([, data]) => (data.requests || 0) > 0)
        .sort(([, left], [, right]) => {
          return (right.totalTokens || 0) - (left.totalTokens || 0)
        })
    },

    sortedProviderAccounts(providerData) {
      return Object.entries(providerData?.accounts || {})
        .filter(([, data]) => (data.requests || 0) > 0)
        .sort(([, left], [, right]) => {
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
  }
}
