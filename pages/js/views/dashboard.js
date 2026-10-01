function dashboardView() {
  return {
    ...ViewHelpers,
    loading: false,
    autoRefresh: true,
    lastRefresh: null,
    refreshInterval: null,
    chartRenderToken: 0,
    trafficChart: null,

    data: {
      activeAccounts: 0,
      totalAccounts: 0,
      activeUsers: 0,
      totalUsers: 0,
      requestsToday: 0,
      errorsToday: 0,
      activeAccountQuota: null,
      totalQuota: null,
      metrics: {
        requestsToday: 0,
        errorsToday: 0,
        successRate: 100,
        inFlightRequests: 0,
        todayTokens: {
          promptTokens: 0,
          completionTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
          cacheHitRate: null,
        },
        performance: {
          avgTtftMs: null,
          avgTps: null,
        },
      },
      alerts: [],
      fleet: {
        total: 0,
        healthy: 0,
        cooldown: 0,
        error: 0,
        disabled: 0,
        items: [],
      },
      hourlyTrend: [],
      topModels: [],
      recentTraces: [],
    },

    init() {
      this.load()

      // 监听全局视图切换：当回到 dashboard 时自动刷新并重绘图表
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "dashboard") {
            this.load(true)
            this.startAutoRefresh()
          } else {
            this.stopAutoRefresh()
          }
        })
      }

      this.startAutoRefresh()
    },

    destroy() {
      this.stopAutoRefresh()
      if (this.trafficChart) {
        this.trafficChart.destroy()
        this.trafficChart = null
      }
    },

    startAutoRefresh() {
      this.stopAutoRefresh()
      if (!this.autoRefresh) return
      // 每 15 秒静默轮询一次
      this.refreshInterval = globalThis.setInterval(() => {
        const app = document.querySelector("[x-data^=adminApp]")
        const isCurrent =
          app ? Alpine.$data(app).currentView === "dashboard" : true
        if (isCurrent && this.autoRefresh) {
          this.load(true)
        }
      }, 15000)
    },

    stopAutoRefresh() {
      if (this.refreshInterval) {
        globalThis.clearInterval(this.refreshInterval)
        this.refreshInterval = null
      }
    },

    toggleAutoRefresh() {
      this.autoRefresh = !this.autoRefresh
      if (this.autoRefresh) {
        this.startAutoRefresh()
      } else {
        this.stopAutoRefresh()
      }
    },

    hasActionableAlerts() {
      return (this.data.alerts || []).some((a) => a.actionable)
    },

    actionableAlertsCount() {
      return (this.data.alerts || []).filter((a) => a.actionable).length
    },

    firstActionableTargetView() {
      const first = (this.data.alerts || []).find((a) => a.actionable)
      return first?.targetView || "accounts"
    },

    async load(silent = false) {
      if (!silent) this.loading = true
      try {
        const dashboard = await API.dashboard.get()
        this.data = {
          ...this.data,
          ...dashboard,
          metrics: {
            ...this.data.metrics,
            ...dashboard?.metrics,
            todayTokens: {
              ...this.data.metrics.todayTokens,
              ...dashboard?.metrics?.todayTokens,
            },
            performance: {
              ...this.data.metrics.performance,
              ...dashboard?.metrics?.performance,
            },
          },
          fleet: {
            ...this.data.fleet,
            ...dashboard?.fleet,
            items: dashboard?.fleet?.items || [],
          },
          alerts: dashboard?.alerts || [],
          hourlyTrend: dashboard?.hourlyTrend || [],
          topModels: dashboard?.topModels || [],
          recentTraces: dashboard?.recentTraces || [],
        }
        this.lastRefresh = new Date()
        this.$nextTick(() => {
          this.renderChart()
          lucide.createIcons()
        })
      } catch {
        if (!silent) {
          this.showToast(I18n.t("error.load"), "error")
        }
      } finally {
        if (!silent) this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    renderChart() {
      this.chartRenderToken += 1
      const token = this.chartRenderToken

      const attempt = (retryCount = 0) => {
        if (token !== this.chartRenderToken) return

        const canvas = document.querySelector("#dashboardTrafficChart")
        if (!canvas || canvas.offsetParent === null) {
          if (retryCount < 20) {
            setTimeout(() => attempt(retryCount + 1), 100)
          }
          return
        }

        if (this.trafficChart) {
          this.trafficChart.destroy()
          this.trafficChart = null
        }

        const ctx = canvas.getContext("2d")
        if (!ctx) return

        const trend = this.data.hourlyTrend || []
        const root = getComputedStyle(document.documentElement)
        const blueColor =
          root.getPropertyValue("--apple-blue")?.trim() || "#007AFF"
        const redColor =
          root.getPropertyValue("--apple-red")?.trim() || "#FF3B30"
        const textColor =
          root.getPropertyValue("--apple-text")?.trim() || "#1D1D1F"
        const textSecondary =
          root.getPropertyValue("--apple-text-secondary")?.trim() || "#86868B"
        const gridColor =
          root.getPropertyValue("--apple-gray-5")?.trim()
          || "rgba(0, 0, 0, 0.05)"

        const labels = trend.map((d) => d.hour)
        const reqData = trend.map((d) => d.requests)

        this.trafficChart = new Chart(ctx, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: I18n.t("dashboard.requestsToday"),
                data: reqData,
                backgroundColor: blueColor + "CC",
                hoverBackgroundColor: blueColor,
                borderRadius: 4,
                borderSkipped: false,
                barPercentage: 0.7,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              intersect: false,
              mode: "index",
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: "rgba(30, 30, 30, 0.9)",
                titleFont: { size: 12, weight: "bold" },
                bodyFont: { size: 12 },
                padding: 10,
                cornerRadius: 8,
                callbacks: {
                  label: (context) => {
                    const idx = context.dataIndex
                    const item = trend[idx]
                    const reqStr = `${I18n.t("dashboard.requestsToday")}: ${context.raw}`
                    if (item && item.totalTokens > 0) {
                      return [
                        reqStr,
                        `Tokens: ${item.totalTokens.toLocaleString()}`,
                        `Cost: $${item.cost.toFixed(4)}`,
                      ]
                    }
                    return reqStr
                  },
                },
              },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: {
                  color: textSecondary,
                  font: { size: 11 },
                  maxTicksLimit: 12,
                },
              },
              y: {
                beginAtZero: true,
                grid: { color: gridColor },
                ticks: {
                  color: textSecondary,
                  font: { size: 11 },
                  precision: 0,
                },
              },
            },
          },
        })
      }

      attempt()
    },

    formatNumber(num) {
      if (num === null || num === undefined) return "0"
      return Number(num).toLocaleString()
    },

    formatTokens(num) {
      if (!num || num <= 0) return "0"
      if (num >= 1e6) return (num / 1e6).toFixed(2) + "M"
      if (num >= 1e3) return (num / 1e3).toFixed(1) + "K"
      return String(num)
    },

    formatCost(num) {
      if (!num || num <= 0) return "$0.00"
      return "$" + Number(num).toFixed(2)
    },

    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleTimeString()
    },

    formatRelativeTime(ts) {
      if (!ts) return "-"
      const diffSec = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000))
      if (diffSec < 60) return `${diffSec}s 前`
      const diffMin = Math.floor(diffSec / 60)
      if (diffMin < 60) return `${diffMin}m 前`
      const diffHour = Math.floor(diffMin / 60)
      return `${diffHour}h 前`
    },

    getSuccessRateColor(rate) {
      if (rate >= 99) return "text-[var(--apple-green)]"
      if (rate >= 95) return "text-[var(--apple-orange)]"
      return "text-[var(--apple-red)]"
    },

    getFleetStatusBadge(status) {
      switch (status) {
        case "healthy":
          return {
            bg: "bg-[var(--apple-green)]/10 text-[var(--apple-green)] border-[var(--apple-green)]/20",
            dot: "bg-[var(--apple-green)]",
            text: "Healthy",
          }
        case "cooldown":
          return {
            bg: "bg-[var(--apple-orange)]/10 text-[var(--apple-orange)] border-[var(--apple-orange)]/20",
            dot: "bg-[var(--apple-orange)] animate-pulse",
            text: "Cooldown",
          }
        case "error":
          return {
            bg: "bg-[var(--apple-red)]/10 text-[var(--apple-red)] border-[var(--apple-red)]/20",
            dot: "bg-[var(--apple-red)]",
            text: "Error",
          }
        case "exhausted":
          return {
            bg: "bg-neutral-500/10 text-neutral-400 border-neutral-500/20",
            dot: "bg-neutral-400",
            text: "Exhausted",
          }
        case "disabled":
        default:
          return {
            bg: "bg-neutral-500/10 text-neutral-400 border-neutral-500/20",
            dot: "bg-neutral-400",
            text: "Disabled",
          }
      }
    },

    getTraceStatusBadge(trace) {
      if (trace.inFlight) {
        return {
          class:
            "bg-[var(--apple-blue)]/15 text-[var(--apple-blue)] border-[var(--apple-blue)]/30 animate-pulse",
          text: "IN-FLIGHT",
        }
      }
      if (trace.ok) {
        return {
          class:
            "bg-[var(--apple-green)]/15 text-[var(--apple-green)] border-[var(--apple-green)]/30",
          text: String(trace.statusCode || 200),
        }
      }
      return {
        class:
          "bg-[var(--apple-red)]/15 text-[var(--apple-red)] border-[var(--apple-red)]/30",
        text: String(trace.statusCode || 500),
      }
    },
  }
}
