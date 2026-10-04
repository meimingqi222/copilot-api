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

    // UX 重构与导航状态
    activeTab: "channels", // 'channels' | 'models' | 'providers'
    searchQuery: "",
    hideEmpty: true,
    viewMode: "pipeline", // 'pipeline' | 'table'
    sortBy: "requests", // 'requests' | 'ttft' | 'tps' | 'model'
    sortDesc: true,
    expandedRows: {}, // rowKey -> boolean, 默认全部折叠, 彻底杜绝页面过长
    expandedStages: {}, // rowKey:stageId -> boolean
    showGuide: false, // 是否展开指标说明

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

        // 如果没有 details 但有 performance 聚合数据，自动切换到 models tab
        if (
          !this.details.length
          && this.performance.length
          && this.activeTab === "channels"
        ) {
          this.activeTab = "models"
        }

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

    // 全局大盘核心 KPI
    get globalStats() {
      const details = this.details || []
      const perf = this.performance || []
      let totalRequests = 0
      let totalSamples = 0
      let ttftSum = 0
      let ttftCount = 0
      let tpsWeightedSum = 0
      let tpsCount = 0
      let proxyOverheadSum = 0
      let upstreamSum = 0

      // 1. 全局流式 TPS 均值与 TTFT 优先对齐 dashboard 官方大盘算法：
      // 从 perf (this.performance) 读取各模型的实际流式速率，按流式样本数进行真实加权。
      // range-query.ts 的模型级聚合是基于 SQLite streamTokenSeconds 真实吞吐计算的，
      // 绝不会因为单次微秒除零或极短突发导致均值爆炸到数千 tok/s。
      if (perf && perf.length > 0) {
        for (const row of perf) {
          totalRequests += row.requests || 0
          if (
            typeof row.avgTtftMs === "number"
            && row.avgTtftMs > 0
            && row.requests > 0
          ) {
            ttftSum += row.avgTtftMs * row.requests
            ttftCount += row.requests
          }
          const tps = row.avgStreamingTps ?? row.avgNonStreamingTps
          const sReqs = row.streamingRequests || 0
          if (typeof tps === "number" && tps > 0 && sReqs > 0) {
            const saneTps = Math.min(tps, 800)
            tpsWeightedSum += saneTps * sReqs
            tpsCount += sReqs
            totalSamples += sReqs
          }
        }
      }

      // 2. 如果 perf 为空或无流式样本，回退使用 details 汇总
      if (tpsCount === 0 && details.length > 0) {
        for (const row of details) {
          if (!totalRequests) totalRequests += row.requests || 0
          const t = row.timings || {}
          const ttft = t.outputTtftMs?.p50 ?? t.outputTtftMs?.average
          if (!ttftCount && typeof ttft === "number" && ttft > 0) {
            const s = t.outputTtftMs?.samples || row.requests || 1
            ttftSum += ttft * s
            ttftCount += s
          }
          if (
            row.generationSamples
            && row.generationTps
            && row.generationTps > 0
          ) {
            const saneTps = Math.min(row.generationTps, 800)
            totalSamples += row.generationSamples
            tpsWeightedSum += saneTps * row.generationSamples
            tpsCount += row.generationSamples
          }
        }
      }

      // 补齐总请求数
      if (totalRequests === 0) {
        for (const row of details) {
          totalRequests += row.requests || 0
        }
      }

      // 3. 计算代理层开销（从 details 汇总）
      for (const row of details) {
        const reqs = row.requests || 1
        const t = row.timings || {}
        const gatewayMs = t.preprocessingMs?.average || 0
        const dispatchMs =
          (t.adapterPreparationMs?.average || 0)
          + (t.requestTranslationMs?.average || 0)
        const downstreamMs = t.downstreamWriteMs?.average || 0
        const proxyMs = gatewayMs + dispatchMs + downstreamMs
        const upMs =
          t.dispatchToOutputMs?.average
          || t.upstreamFirstEventMs?.average
          || t.upstreamBodyReadMs?.average
          || 0

        if (upMs > 0 || proxyMs > 0) {
          proxyOverheadSum += proxyMs * reqs
          upstreamSum += upMs * reqs
        }
      }

      const avgTtft = ttftCount > 0 ? ttftSum / ttftCount : null
      const avgTps = tpsCount > 0 ? tpsWeightedSum / tpsCount : null
      const totalTime = proxyOverheadSum + upstreamSum
      const upstreamRatio =
        totalTime > 0 ? Math.round((upstreamSum / totalTime) * 100) : 99
      const proxyOverheadMs =
        totalRequests > 0 ? proxyOverheadSum / totalRequests : 0

      return {
        totalRequests,
        totalSamples,
        channelCount: Math.max(details.length, perf.length),
        avgTtft,
        avgTps,
        upstreamRatio,
        proxyOverheadMs,
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
      if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0)
        return "-"
      if (tps > 800) return ">800"
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 1,
      }).format(tps)
    },

    getChannelTps(row) {
      if (!row.streaming || !row.generationTps) return null
      // 若单通道 generationTps 因极短毫秒突发出现异常 (> 800 tok/s)，回退至对应模型的基准流式 TPS
      if (row.generationTps > 800) {
        const matched = (this.performance || []).find(
          (m) => m.model === row.model,
        )
        if (
          matched
          && typeof matched.avgStreamingTps === "number"
          && matched.avgStreamingTps > 0
          && matched.avgStreamingTps <= 800
        ) {
          return matched.avgStreamingTps
        }
        return 800
      }
      return row.generationTps
    },

    getTtftClass(ms) {
      if (ms === null || ms === undefined)
        return "text-[var(--apple-text-secondary)]"
      if (ms < 800) return "text-[var(--apple-green)]"
      if (ms < 2000) return "text-[var(--apple-orange)]"
      return "text-[var(--apple-red)]"
    },

    getTpsClass(tps) {
      if (tps === null || tps === undefined)
        return "text-[var(--apple-text-secondary)]"
      if (tps >= 50) return "text-[var(--apple-green)] font-semibold"
      if (tps >= 20) return "text-[var(--apple-orange)]"
      return "text-[var(--apple-text)]"
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

    get sortedDetails() {
      const list = [...this.filteredDetails]
      const dir = this.sortDesc ? -1 : 1

      list.sort((a, b) => {
        if (this.sortBy === "requests") {
          return (a.requests - b.requests) * dir
        }
        if (this.sortBy === "ttft") {
          const aVal =
            a.timings?.outputTtftMs?.p50
            ?? a.timings?.outputTtftMs?.average
            ?? (this.sortDesc ? -1 : 999999)
          const bVal =
            b.timings?.outputTtftMs?.p50
            ?? b.timings?.outputTtftMs?.average
            ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "tps") {
          const aVal = this.getChannelTps(a) ?? (this.sortDesc ? -1 : 999999)
          const bVal = this.getChannelTps(b) ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "model") {
          return (a.model || "").localeCompare(b.model || "") * dir
        }
        return 0
      })
      return list
    },

    get sortedModels() {
      const query = (this.searchQuery || "").trim().toLowerCase()
      const list = (this.performance || []).filter((row) => {
        if (!query) return true
        return (row.model || "").toLowerCase().includes(query)
      })
      const dir = this.sortDesc ? -1 : 1

      list.sort((a, b) => {
        if (this.sortBy === "requests") {
          return (a.requests - b.requests) * dir
        }
        if (this.sortBy === "ttft") {
          const aVal = a.avgTtftMs ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgTtftMs ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "tps") {
          const aVal = a.avgStreamingTps ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgStreamingTps ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "model") {
          return (a.model || "").localeCompare(b.model || "") * dir
        }
        return 0
      })
      return list
    },

    get sortedProviders() {
      const query = (this.searchQuery || "").trim().toLowerCase()
      const list = (this.filteredByProvider || []).filter((row) => {
        if (!query) return true
        const matchModel = (row.model || "").toLowerCase().includes(query)
        const matchProvider = (row.provider || "").toLowerCase().includes(query)
        const matchLabel = (row.providerLabel || "")
          .toLowerCase()
          .includes(query)
        return matchModel || matchProvider || matchLabel
      })
      const dir = this.sortDesc ? -1 : 1

      list.sort((a, b) => {
        if (this.sortBy === "requests") {
          return (a.requests - b.requests) * dir
        }
        if (this.sortBy === "ttft") {
          const aVal = a.avgTtftMs ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgTtftMs ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "tps") {
          const aVal = a.avgStreamingTps ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgStreamingTps ?? (this.sortDesc ? -1 : 999999)
          return (aVal - bVal) * dir
        }
        if (this.sortBy === "model") {
          return (a.model || "").localeCompare(b.model || "") * dir
        }
        return 0
      })
      return list
    },

    setSort(field) {
      if (this.sortBy === field) {
        this.sortDesc = !this.sortDesc
      } else {
        this.sortBy = field
        this.sortDesc = true
      }
    },

    // 行展开与折叠控制
    isRowExpanded(rowKey) {
      return Boolean(this.expandedRows[rowKey])
    },

    toggleRow(rowKey) {
      this.expandedRows[rowKey] = !this.isRowExpanded(rowKey)
      this.$nextTick?.(() => window.lucide?.createIcons?.())
    },

    expandAllRows() {
      const currentlyAll = this.isAllRowsExpanded()
      for (const row of this.filteredDetails) {
        this.expandedRows[this.getRowKey(row)] = !currentlyAll
      }
      this.$nextTick?.(() => window.lucide?.createIcons?.())
    },

    isAllRowsExpanded() {
      if (!this.filteredDetails.length) return false
      return this.filteredDetails.every((r) =>
        this.isRowExpanded(this.getRowKey(r)),
      )
    },

    getThinkingDiff(row) {
      const t = row.timings || {}
      if (t.textTtftMs?.average && t.outputTtftMs?.average) {
        const diff = t.textTtftMs.average - t.outputTtftMs.average
        if (diff >= 300) {
          return (diff / 1000).toFixed(1)
        }
      }
      return null
    },

    getProxyOverhead(row) {
      const t = row.timings || {}
      const gatewayMs = t.preprocessingMs?.average || 0
      const dispatchMs =
        (t.adapterPreparationMs?.average || 0)
        + (t.requestTranslationMs?.average || 0)
      const downstreamMs = t.downstreamWriteMs?.average || 0
      const proxyMs = gatewayMs + dispatchMs + downstreamMs
      const total =
        t.outputTtftMs?.average || t.responseReadyMs?.average || proxyMs
      const pct =
        total > 0 ? Math.min(100, Math.round((proxyMs / total) * 100)) : 0
      return { ms: proxyMs, pct }
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
  }
}
