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
    ...usageAutoRefresh("performance"),
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

    // TPS 走势图状态
    trendCharts: {}, // rowKey -> Chart instance
    trendData: {}, // rowKey -> trend response
    trendLoading: {}, // rowKey -> boolean
    trendMetricMode: {}, // rowKey -> 'all' | 'decode' | 'stream' | 'providers'

    lifecycleStages: LIFECYCLE_STAGES,

    init() {
      this.initAutoRefresh()
      this.load()
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) {
        Alpine.$data(app).$watch("currentView", (view) => {
          if (view === "performance") {
            this.load()
          } else {
            this.destroyTrendCharts()
          }
        })
      }
    },

    destroyTrendCharts() {
      for (const [key, chart] of Object.entries(this.trendCharts)) {
        try {
          chart?.destroy()
        } catch {
          // ignore destroy errors
        }
      }
      this.trendCharts = {}
    },

    destroyChart() {
      this.destroyTrendCharts()
    },

    async refreshCachedUsage() {
      // 仅日线 (today) 会有持续请求流入；历史范围数据不变，无需自动轮询
      if (this.dateRange !== "today") return

      // 1. 静默刷新表格与大盘数据（避免整屏 loading 遮罩）
      try {
        const data = await API.usage.performance({ range: "today" })
        this.performance = data.performance || []
        this.byProvider = data.byProvider || []
        this.details = data.details || []
        this.period = data.period || this.period
        this.lastUpdatedAt = Date.now()
      } catch (e) {
        console.warn("Performance auto refresh failed", e)
      }

      // 2. 检查当前处于展开状态的走势图 (按模型与按供应商)
      const activeKeys = Object.keys(this.expandedRows).filter(
        (key) =>
          this.expandedRows[key]
          && (key.startsWith("model::") || key.startsWith("prov::")),
      )
      if (!activeKeys.length) return

      // 3. 静默增量更新已展开的走势图（使用 Promise.allSettled 控制并发）
      await Promise.allSettled(
        activeKeys.map(async (key) => {
          try {
            const isModel = key.startsWith("model::")
            const canvasId = "trend_chart_" + this.sanitizeChartId(key)
            const queryParams = { range: "today" }
            if (isModel) {
              queryParams.model = key.slice("model::".length)
            } else {
              const parts = key.split("::")
              queryParams.provider = parts[1]
              queryParams.model = parts[2]
            }
            const trend = await API.usage.performanceTrend(queryParams)
            this.trendData[key] = trend
            this.updateOrRenderTrendChart(key, canvasId, trend)
          } catch (err) {
            console.warn(`Trend silent refresh failed for ${key}`, err)
          }
        }),
      )
    },

    setRange(range) {
      this.destroyTrendCharts()
      this.trendData = {}
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
      this.destroyTrendCharts()
      this.trendData = {}
      this.dateRange = "custom"
      this.selectedMonth = month
      this.loadPerformance().catch(() => {
        this.showToast(this.t("error.load"), "error")
      })
    },

    async load() {
      if (this.loading) return
      this.loading = true
      this.destroyTrendCharts()
      this.trendData = {}
      try {
        await this.loadPerformance()
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick?.(() => refreshAdminIcons(this.$el))
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
      // 按标签而不是键排序：plain connection 的键是 `connection:<id>`，
      // 按键排等于按 uuid 排，对人没有意义。
      return [...seen.entries()]
        .map(([provider, label]) => ({ provider, label }))
        .sort((left, right) => left.label.localeCompare(right.label))
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

    // 解码 TPS 只覆盖已采集分段性能的流式请求，悬停说明这行的样本量
    decodeTpsTitle(row) {
      const samples = row.decodeSamples || 0
      if (!samples || !row.avgDecodeTps) return this.t("perf.decodeTpsMissing")
      return this.t("perf.decodeTpsSamples", { samples })
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
        row.connectionId,
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
      const providerKeys = new Set(
        (this.byProvider || []).map((row) => row.provider),
      )
      return this.details.filter((row) => {
        // 明细保留原始 protocol；筛选键与汇总一致，已删除连接仍落在协议桶。
        const connectionKey = "connection:" + row.connectionId
        const providerKey =
          providerKeys.has(connectionKey) ? connectionKey : row.provider
        if (
          this.providerFilter !== "all"
          && providerKey !== this.providerFilter
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
          const matchConnection = (row.connectionName || "")
            .toLowerCase()
            .includes(query)
          if (
            !matchModel
            && !matchProvider
            && !matchEndpoint
            && !matchConnection
          ) {
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
        if (this.sortBy === "decodeTps") {
          const aVal = a.avgDecodeTps ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgDecodeTps ?? (this.sortDesc ? -1 : 999999)
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
        if (this.sortBy === "decodeTps") {
          const aVal = a.avgDecodeTps ?? (this.sortDesc ? -1 : 999999)
          const bVal = b.avgDecodeTps ?? (this.sortDesc ? -1 : 999999)
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
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    expandAllRows() {
      const currentlyAll = this.isAllRowsExpanded()
      for (const row of this.filteredDetails) {
        this.expandedRows[this.getRowKey(row)] = !currentlyAll
      }
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    isAllRowsExpanded() {
      if (!this.filteredDetails.length) return false
      return this.filteredDetails.every((r) =>
        this.isRowExpanded(this.getRowKey(r)),
      )
    },

    // ── TPS 走势图交互与图表管理 ────────────────────────────────────

    sanitizeChartId(key) {
      return String(key).replace(/[^a-zA-Z0-9_-]/g, "_")
    },

    getTrendMode(key, defaultMode = "all") {
      return this.trendMetricMode[key] || defaultMode
    },

    setTrendMetricMode(key, mode, canvasId) {
      this.trendMetricMode[key] = mode
      const data = this.trendData[key]
      if (data) {
        this.$nextTick(() => this.renderTrendChart(key, canvasId, data))
      }
    },

    toggleModelTrend(model) {
      const key = "model::" + model
      const willExpand = !this.isRowExpanded(key)
      this.expandedRows[key] = willExpand

      if (willExpand) {
        const canvasId = "trend_chart_" + this.sanitizeChartId(key)
        this.loadAndRenderTrend(key, canvasId, { model })
      } else {
        if (this.trendCharts[key]) {
          this.trendCharts[key].destroy()
          delete this.trendCharts[key]
        }
      }
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    getProviderRowKey(row) {
      return "prov::" + (row.provider || "unknown") + "::" + row.model
    },

    toggleProviderTrend(row) {
      const key = this.getProviderRowKey(row)
      const willExpand = !this.isRowExpanded(key)
      this.expandedRows[key] = willExpand

      if (willExpand) {
        const canvasId = "trend_chart_" + this.sanitizeChartId(key)
        this.loadAndRenderTrend(key, canvasId, {
          model: row.model,
          provider: row.provider,
        })
      } else {
        if (this.trendCharts[key]) {
          this.trendCharts[key].destroy()
          delete this.trendCharts[key]
        }
      }
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    async loadAndRenderTrend(key, canvasId, params) {
      this.trendLoading[key] = true
      try {
        const queryParams = {
          ...params,
          range: this.dateRange,
          month: this.dateRange === "custom" ? this.selectedMonth : undefined,
        }
        const data = await API.usage.performanceTrend(queryParams)
        this.trendData[key] = data
        this.$nextTick(() => {
          this.renderTrendChart(key, canvasId, data)
        })
      } catch {
        this.showToast?.(I18n.t("error.load"), "error")
      } finally {
        this.trendLoading[key] = false
        this.$nextTick?.(() => refreshAdminIcons(this.$el))
      }
    },

    renderTrendChart(key, canvasId, data, retryCount = 0) {
      if (typeof Chart === "undefined") return

      const canvas = document.getElementById(canvasId)
      if (!canvas || canvas.offsetParent === null) {
        if (retryCount < 20) {
          setTimeout(
            () => this.renderTrendChart(key, canvasId, data, retryCount + 1),
            60,
          )
        }
        return
      }

      if (this.trendCharts[key]) {
        this.trendCharts[key].destroy()
        delete this.trendCharts[key]
      }

      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const series = data.series || []
      if (!series.length) return

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
      const textColor =
        root.getPropertyValue("--apple-text")?.trim() || "#1D1D1F"
      const secondaryText =
        root.getPropertyValue("--apple-text-secondary")?.trim() || "#86868B"

      const palette = [
        blueColor,
        greenColor,
        orangeColor,
        purpleColor,
        pinkColor,
      ]

      const firstTs = series[0]?.slotTs || 0
      const lastTs = series[series.length - 1]?.slotTs || 0
      const spanHours = (lastTs - firstTs) / (3600 * 1000)
      const useDatePrefix = spanHours > 24

      const labels = series.map((d) => {
        const date = new Date(d.slotTs)
        const hh = String(date.getHours()).padStart(2, "0")
        const mm = String(date.getMinutes()).padStart(2, "0")
        if (useDatePrefix) {
          const m = date.getMonth() + 1
          const day = date.getDate()
          return `${m}/${day} ${hh}:${mm}`
        }
        return `${hh}:${mm}`
      })

      const mode = this.getTrendMode(
        key,
        data.byProvider && data.byProvider.length > 1 ? "providers" : "all",
      )

      const datasets = []

      if (mode === "providers" && data.byProvider?.length) {
        data.byProvider.forEach((p, idx) => {
          const color = palette[idx % palette.length]
          datasets.push({
            label: `${p.providerLabel} (${I18n.t("perf.decodeTps")})`,
            data: p.series.map((s) => s.avgDecodeTps ?? s.avgStreamingTps),
            borderColor: color,
            backgroundColor: color + "15",
            fill: false,
            tension: 0.35,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            borderWidth: 2,
            spanGaps: true,
          })
        })
      } else {
        if (mode === "all" || mode === "decode") {
          datasets.push({
            label: I18n.t("perf.decodeTps"),
            data: series.map((s) => s.avgDecodeTps),
            borderColor: greenColor,
            backgroundColor: greenColor + "15",
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2.5,
            spanGaps: true,
          })
        }
        if (mode === "all" || mode === "stream") {
          datasets.push({
            label: I18n.t("perf.streamingTps"),
            data: series.map((s) => s.avgStreamingTps),
            borderColor: blueColor,
            backgroundColor: blueColor + "10",
            fill: false,
            borderDash: mode === "all" ? [4, 4] : undefined,
            tension: 0.35,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            borderWidth: 2,
            spanGaps: true,
          })
        }
      }

      this.trendCharts[key] = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              position: "top",
              align: "end",
              labels: {
                boxWidth: 10,
                boxHeight: 10,
                usePointStyle: true,
                color: secondaryText,
                font: {
                  size: 11,
                  family: "-apple-system, BlinkMacSystemFont, sans-serif",
                },
              },
            },
            tooltip: {
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              titleColor: textColor,
              bodyColor: textColor,
              borderColor: "rgba(0, 0, 0, 0.1)",
              borderWidth: 1,
              padding: 10,
              boxPadding: 4,
              usePointStyle: true,
              callbacks: {
                label: (tooltipItem) => {
                  const val = tooltipItem.parsed.y
                  if (val === null || val === undefined) return null
                  return `${tooltipItem.dataset.label}: ${val.toFixed(1)} tok/s`
                },
                afterBody: (tooltipItems) => {
                  const idx = tooltipItems[0]?.dataIndex
                  if (idx === undefined) return []
                  const slot = series[idx]
                  if (!slot || !slot.requests) return ["样本: 0 请求"]
                  const extra = [`请求数: ${slot.requests} 次`]
                  if (slot.avgTtftMs) {
                    extra.push(
                      `平均首字: ${(slot.avgTtftMs / 1000).toFixed(2)}s (${Math.round(slot.avgTtftMs)}ms)`,
                    )
                  }
                  return extra
                },
              },
            },
          },
          scales: {
            x: {
              grid: { color: "rgba(0, 0, 0, 0.04)" },
              ticks: {
                color: secondaryText,
                font: { size: 10 },
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 12,
              },
            },
            y: {
              beginAtZero: true,
              grid: { color: "rgba(0, 0, 0, 0.06)" },
              ticks: {
                color: secondaryText,
                font: { size: 10 },
                callback: (val) => `${val} tok/s`,
              },
            },
          },
        },
      })
    },

    updateOrRenderTrendChart(key, canvasId, data) {
      const existingChart = this.trendCharts[key]
      const canvas = document.getElementById(canvasId)
      if (!canvas || !existingChart || !existingChart.ctx) {
        return this.renderTrendChart(key, canvasId, data)
      }

      const series = data.series || []
      if (!series.length) return

      const firstTs = series[0]?.slotTs || 0
      const lastTs = series[series.length - 1]?.slotTs || 0
      const spanHours = (lastTs - firstTs) / (3600 * 1000)
      const useDatePrefix = spanHours > 24

      const labels = series.map((d) => {
        const date = new Date(d.slotTs)
        const hh = String(date.getHours()).padStart(2, "0")
        const mm = String(date.getMinutes()).padStart(2, "0")
        if (useDatePrefix) {
          const m = date.getMonth() + 1
          const day = date.getDate()
          return `${m}/${day} ${hh}:${mm}`
        }
        return `${hh}:${mm}`
      })

      const mode = this.getTrendMode(
        key,
        data.byProvider && data.byProvider.length > 1 ? "providers" : "all",
      )

      const expectedDsCount =
        mode === "providers" ? data.byProvider?.length || 0
        : mode === "all" ? 2
        : 1

      // 若数据集数量或结构变了（如动态新增了 provider），直接做一次完整重绘
      if (
        !existingChart.data.datasets
        || existingChart.data.datasets.length !== expectedDsCount
      ) {
        return this.renderTrendChart(key, canvasId, data)
      }

      existingChart.data.labels = labels

      if (mode === "providers" && data.byProvider?.length) {
        data.byProvider.forEach((p, idx) => {
          if (existingChart.data.datasets[idx]) {
            existingChart.data.datasets[idx].data = p.series.map(
              (s) => s.avgDecodeTps ?? s.avgStreamingTps,
            )
          }
        })
      } else {
        let dsIdx = 0
        if (mode === "all" || mode === "decode") {
          if (existingChart.data.datasets[dsIdx]) {
            existingChart.data.datasets[dsIdx].data = series.map(
              (s) => s.avgDecodeTps,
            )
            dsIdx++
          }
        }
        if (mode === "all" || mode === "stream") {
          if (existingChart.data.datasets[dsIdx]) {
            existingChart.data.datasets[dsIdx].data = series.map(
              (s) => s.avgStreamingTps,
            )
          }
        }
      }

      // 静默原地刷新，无动画，零闪烁
      existingChart.update("none")
    },

    getTrendPeak(key) {
      const series = this.trendData[key]?.series || []
      const vals = series
        .map((s) => s.avgDecodeTps ?? s.avgStreamingTps)
        .filter((v) => typeof v === "number" && v > 0)
      if (!vals.length) return "-"
      return Math.max(...vals).toFixed(1)
    },

    getTrendAvg(key) {
      const series = this.trendData[key]?.series || []
      const vals = series
        .map((s) => s.avgDecodeTps ?? s.avgStreamingTps)
        .filter((v) => typeof v === "number" && v > 0)
      if (!vals.length) return "-"
      const sum = vals.reduce((a, b) => a + b, 0)
      return (sum / vals.length).toFixed(1)
    },

    getTrendRequests(key) {
      const series = this.trendData[key]?.series || []
      return series.reduce((sum, s) => sum + (s.requests || 0), 0)
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
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    toggleAllStages(rowKey) {
      const currentlyAll = this.isAllExpanded(rowKey)
      for (const stage of this.lifecycleStages) {
        this.expandedStages[`${rowKey}:${stage.id}`] = !currentlyAll
      }
      this.$nextTick?.(() => refreshAdminIcons(this.$el))
    },

    isAllExpanded(rowKey) {
      return this.lifecycleStages.every((s) =>
        this.isStageExpanded(rowKey, s.id),
      )
    },
  }
}
