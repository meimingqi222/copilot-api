function performanceView() {
  const LIFECYCLE_STAGES = [
    {
      id: "gateway",
      nameKey: "perf.stage.gateway",
      descKey: "perf.stage.gatewayDesc",
      color: "var(--apple-blue)",
      primaryTiming: "preprocessingMs",
      fields: [
        "preprocessingMs",
        "bodyParseMs",
        "bodyReadMs",
        "jsonDecodeMs",
        "admissionMs",
        "routingDecisionMs",
        "tokenEstimateMs",
      ],
    },
    {
      id: "dispatch",
      nameKey: "perf.stage.dispatch",
      descKey: "perf.stage.dispatchDesc",
      color: "var(--apple-purple)",
      primaryTiming: "adapterPreparationMs",
      fields: [
        "adapterPreparationMs",
        "requestTranslationMs",
        "rateLimitWaitMs",
        "failedAttemptMs",
      ],
    },
    {
      id: "upstream",
      nameKey: "perf.stage.upstream",
      descKey: "perf.stage.upstreamDesc",
      color: "var(--apple-orange)",
      primaryTiming: "upstreamFirstEventMs",
      fields: [
        "dispatchToOutputMs",
        "upstreamHeadersMs",
        "upstreamConnectMs",
        "upstreamQueueMs",
        "upstreamFirstEventMs",
        "upstreamToOutputMs",
        "upstreamBodyReadMs",
      ],
    },
    {
      id: "downstream",
      nameKey: "perf.stage.downstream",
      descKey: "perf.stage.downstreamDesc",
      color: "var(--apple-green)",
      primaryTiming: "downstreamWriteMs",
      fields: [
        "firstTranslatedFrameMs",
        "responseTranslationMs",
        "streamTranslationActiveMs",
        "downstreamWriteMs",
        "outputToWriteMs",
        "responseReadyMs",
      ],
    },
  ]

  return {
    ...ViewHelpers,
    loading: false,
    dateRange: "today",
    selectedMonth: "",
    performance: [],
    byProvider: [],
    details: [],
    providerFilter: "all",
    period: { startDate: "", endDate: "" },

    // UX 重构增强状态
    searchQuery: "",
    hideEmpty: true,
    viewMode: "pipeline", // 'pipeline' | 'table'
    expandedStages: {},

    lifecycleStages: LIFECYCLE_STAGES,

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
        this.$nextTick?.(() => window.lucide?.createIcons?.())
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
        this.details = data.details || []
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
        this.performance = []
        this.byProvider = []
        this.details = []
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

    getRowKey(row) {
      return [
        row.provider,
        row.model,
        row.endpoint,
        row.transport,
        row.translated,
        row.streaming,
      ].join("::")
    },

    get filteredDetails() {
      const query = (this.searchQuery || "").trim().toLowerCase()
      return this.details.filter((row) => {
        if (
          this.providerFilter !== "all"
          && row.provider !== this.providerFilter
        ) {
          return false
        }
        if (query) {
          const matchModel = (row.model || "").toLowerCase().includes(query)
          const matchProvider = (row.provider || "")
            .toLowerCase()
            .includes(query)
          const matchEndpoint = (row.endpoint || "")
            .toLowerCase()
            .includes(query)
          if (!matchModel && !matchProvider && !matchEndpoint) {
            return false
          }
        }
        return true
      })
    },

    getStageMetrics(row, stageId) {
      const stage = this.lifecycleStages.find((s) => s.id === stageId)
      if (!stage || !row.timings) return []
      return stage.fields
        .map((field) => ({
          field,
          timing: row.timings[field] || {
            samples: 0,
            average: null,
            p50: null,
            p95: null,
          },
        }))
        .filter((item) => {
          if (!this.hideEmpty) return true
          return item.timing.samples > 0
        })
    },

    getStageSummary(row, stageId) {
      if (!row.timings) return null
      const stage = this.lifecycleStages.find((s) => s.id === stageId)
      if (!stage) return null

      // 首选主指标，若主指标无数据则退回该阶段首个有 samples 的指标
      const primary = row.timings[stage.primaryTiming]
      if (primary && primary.samples > 0) return primary

      for (const field of stage.fields) {
        const item = row.timings[field]
        if (item && item.samples > 0) return item
      }
      return primary || null
    },

    getPipelineBreakdown(row) {
      const t = row.timings || {}
      const gatewayMs = t.preprocessingMs?.average || 0
      const dispatchMs =
        (t.adapterPreparationMs?.average || 0)
        + (t.rateLimitWaitMs?.average || 0)
        + (t.requestTranslationMs?.average || 0)
      const upstreamMs =
        row.streaming ?
          t.dispatchToOutputMs?.average
          || t.upstreamFirstEventMs?.average
          || t.upstreamHeadersMs?.average
          || 0
        : t.upstreamBodyReadMs?.average || t.upstreamHeadersMs?.average || 0
      const downstreamMs =
        t.downstreamWriteMs?.average || t.responseTranslationMs?.average || 0

      const sumMs = gatewayMs + dispatchMs + upstreamMs + downstreamMs
      const totalMs = Math.max(
        t.outputTtftMs?.average || t.responseReadyMs?.average || sumMs,
        0.001,
      )

      return [
        {
          id: "gateway",
          name: this.t("perf.stage.gateway"),
          ms: gatewayMs,
          color: "var(--apple-blue)",
          pct: Math.min(100, Math.round((gatewayMs / totalMs) * 100)),
        },
        {
          id: "dispatch",
          name: this.t("perf.stage.dispatch"),
          ms: dispatchMs,
          color: "var(--apple-purple)",
          pct: Math.min(100, Math.round((dispatchMs / totalMs) * 100)),
        },
        {
          id: "upstream",
          name: this.t("perf.stage.upstream"),
          ms: upstreamMs,
          color: "var(--apple-orange)",
          pct: Math.min(100, Math.round((upstreamMs / totalMs) * 100)),
        },
        {
          id: "downstream",
          name: this.t("perf.stage.downstream"),
          ms: downstreamMs,
          color: "var(--apple-green)",
          pct: Math.min(100, Math.round((downstreamMs / totalMs) * 100)),
        },
      ]
    },

    getInsights(row) {
      const insights = []
      const t = row.timings || {}
      const total = t.outputTtftMs?.average || t.responseReadyMs?.average || 0
      const upstream =
        t.dispatchToOutputMs?.average
        || t.upstreamFirstEventMs?.average
        || t.upstreamHeadersMs?.average
        || 0

      // 1. 上游耗时瓶颈分析
      if (total > 0 && upstream > 0) {
        const upstreamPct = Math.round((upstream / total) * 100)
        if (upstreamPct >= 70) {
          insights.push({
            type: "upstream",
            icon: "cloud",
            class: "badge-warning",
            text: this.t("perf.insightUpstreamBottleneck", {
              pct: upstreamPct,
            }),
          })
        }
      }

      // 2. 客户端网络上传分析
      if (t.bodyReadMs?.average && t.preprocessingMs?.average) {
        const bodyRatio = t.bodyReadMs.average / t.preprocessingMs.average
        if (bodyRatio >= 0.7 && t.bodyReadMs.average >= 200) {
          insights.push({
            type: "network",
            icon: "upload",
            class: "badge-info",
            text: this.t("perf.insightClientUpload", {
              ms: this.formatMs(t.bodyReadMs.average),
            }),
          })
        }
      }

      // 3. 模型前置思考/工具调用耗时
      if (t.textTtftMs?.average && t.outputTtftMs?.average) {
        const diffMs = t.textTtftMs.average - t.outputTtftMs.average
        if (diffMs >= 1000) {
          insights.push({
            type: "thinking",
            icon: "sparkles",
            class: "badge-purple",
            text: this.t("perf.insightThinkingTime", {
              sec: (diffMs / 1000).toFixed(1),
            }),
          })
        }
      }

      // 4. 本地限流排队
      if (t.rateLimitWaitMs?.average && t.rateLimitWaitMs.average > 50) {
        insights.push({
          type: "ratelimit",
          icon: "timer",
          class: "badge-warning",
          text: this.t("perf.insightRateLimited", {
            ms: this.formatMs(t.rateLimitWaitMs.average),
          }),
        })
      }

      // 5. 失败重试
      if (t.failedAttemptMs?.average && t.failedAttemptMs.average > 50) {
        insights.push({
          type: "retry",
          icon: "alert-triangle",
          class: "badge-danger",
          text: this.t("perf.insightFailoverRetries", {
            ms: this.formatMs(t.failedAttemptMs.average),
          }),
        })
      }

      return insights
    },

    isStageExpanded(rowKey, stageId) {
      const key = `${rowKey}:${stageId}`
      return this.expandedStages[key] ?? false
    },

    toggleStage(rowKey, stageId) {
      const key = `${rowKey}:${stageId}`
      this.expandedStages[key] = !this.isStageExpanded(rowKey, stageId)
      this.$nextTick?.(() => window.lucide?.createIcons?.())
    },

    toggleAllStages(rowKey) {
      const currentlyAll = this.isAllExpanded(rowKey)
      for (const stage of this.lifecycleStages) {
        this.expandedStages[`${rowKey}:${stage.id}`] = !currentlyAll
      }
      this.$nextTick?.(() => window.lucide?.createIcons?.())
    },

    isAllExpanded(rowKey) {
      return this.lifecycleStages.every((s) =>
        this.isStageExpanded(rowKey, s.id),
      )
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
