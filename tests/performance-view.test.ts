import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

// Mock 基础运行环境
const mockI18n = {
  t(key: string, params: Record<string, unknown> = {}) {
    let text = key
    if (key === "perf.insightUpstreamBottleneck")
      text = "上游模型响应与推理占耗时绝对主导（{pct}%）"
    if (key === "perf.insightClientUpload")
      text = "网关前置耗时主要为客户端网络上传等待（{ms}）"
    if (key === "perf.insightThinkingTime")
      text = "包含约 {sec}s 模型前置思考/工具调用耗时"
    if (key === "perf.insightRateLimited")
      text = "检测到本地限流等待（累计 {ms}）"
    if (key === "perf.insightFailoverRetries")
      text = "发生过失败调度并触发重试（累计耗时 {ms}）"
    if (key === "perf.stage.gateway") text = "网关接入与准入"
    if (key === "perf.decodeTpsSamples") text = "解码速率可用样本 {samples} 条"
    if (key === "perf.decodeTpsMissing") text = "未采集分段性能"
    if (key === "perf.stage.dispatch") text = "调度与格式准备"
    if (key === "perf.stage.upstream") text = "上游响应与推理"
    if (key === "perf.stage.downstream") text = "流转换与下游写出"
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  },
}

const mockViewHelpers = {
  t(key: string, params?: Record<string, unknown>) {
    return mockI18n.t(key, params)
  },
}

const sandbox = {
  ViewHelpers: mockViewHelpers,
  I18n: mockI18n,
  Alpine: { $data: () => ({ $watch: () => {} }) },
  document: { querySelector: () => null },
  window: {},
  Intl,
  Math,
  performanceView: null as any,
}

runInNewContext(
  readFileSync("pages/js/usage-auto-refresh.js", "utf8")
    + "\n"
    + readFileSync("pages/js/views/performance.js", "utf8")
    + "\nsandbox.performanceView = performanceView;",
  { sandbox, ...sandbox },
)

describe("performanceView UX redesign", () => {
  test("connection provider filters keep only their channel details", () => {
    const view = sandbox.performanceView()
    const deepseek = {
      provider: "openai-compatible",
      connectionId: "deepseek",
      connectionName: "DeepSeek",
      model: "shared",
    }
    const other = {
      ...deepseek,
      connectionId: "other",
      connectionName: "Other",
    }
    const copilot = {
      ...deepseek,
      provider: "copilot",
      connectionId: "copilot-1",
    }
    const deleted = { ...deepseek, connectionId: "deleted" }
    view.details = [deepseek, other, copilot, deleted]
    view.byProvider = [
      { provider: "connection:deepseek", providerLabel: "DeepSeek" },
      { provider: "connection:other", providerLabel: "Other" },
      { provider: "copilot", providerLabel: "GitHub Copilot" },
      { provider: "openai-compatible", providerLabel: "OpenAI Compatible" },
    ]
    view.providerFilter = view.providerOptions.find(
      (option: { label: string }) => option.label === "DeepSeek",
    ).provider
    expect(view.filteredDetails).toEqual([deepseek])
    view.searchQuery = "missing"
    expect(view.filteredDetails).toEqual([])
    view.searchQuery = ""
    view.providerFilter = "copilot"
    expect(view.filteredDetails).toEqual([copilot])
    view.providerFilter = "openai-compatible"
    expect(view.filteredDetails).toEqual([deleted])
    view.providerFilter = "all"
    expect(view.filteredDetails).toEqual([deepseek, other, copilot, deleted])
  })

  test("connection names are searchable and connection IDs distinguish channel keys", () => {
    const view = sandbox.performanceView()
    const first = {
      provider: "openai-compatible",
      model: "deepseek-v4.1-flash",
      connectionId: "command-code",
      connectionName: "Command Code",
    }
    const second = { ...first, connectionId: "other", connectionName: "Other" }
    view.details = [first, second]
    view.searchQuery = "command code"
    expect(view.filteredDetails).toEqual([first])
    expect(view.getRowKey(first)).not.toBe(view.getRowKey(second))
    const template = readFileSync(
      "pages/partials/performance-detail.html",
      "utf8",
    )
    expect(template).toContain('x-text="row.connectionName || row.provider"')
  })
  const sampleUserRow = {
    provider: "openai-compatible",
    model: "deepseek-v4.1-flash",
    endpoint: "/v1/chat/completions",
    transport: "http",
    translated: false,
    streaming: true,
    requests: 35,
    generationSamples: 35,
    generationTps: 191.98,
    timings: {
      outputTtftMs: { samples: 35, average: 12500, p50: 8200, p95: 34200 },
      textTtftMs: { samples: 21, average: 19200, p50: 11500, p95: 38000 },
      firstWriteMs: { samples: 35, average: 12200, p50: 8100, p95: 34200 },
      preprocessingMs: { samples: 35, average: 965, p50: 1100, p95: 1100 },
      bodyParseMs: { samples: 35, average: 938, p50: 1000, p95: 1100 },
      bodyReadMs: { samples: 35, average: 928, p50: 1000, p95: 1100 },
      jsonDecodeMs: { samples: 35, average: 10, p50: 11, p95: 19 },
      admissionMs: { samples: 35, average: 21, p50: 22, p95: 33 },
      routingDecisionMs: { samples: 35, average: 7, p50: 9, p95: 15 },
      tokenEstimateMs: { samples: 35, average: 4, p50: 4, p95: 6 },
      dispatchToOutputMs: {
        samples: 35,
        average: 11500,
        p50: 7300,
        p95: 33500,
      },
      requestTranslationMs: { samples: 0, average: null, p50: null, p95: null },
      firstTranslatedFrameMs: {
        samples: 0,
        average: null,
        p50: null,
        p95: null,
      },
      rateLimitWaitMs: { samples: 35, average: 0, p50: 0, p95: 0 },
      failedAttemptMs: { samples: 0, average: null, p50: null, p95: null },
      upstreamHeadersMs: { samples: 35, average: 11300, p50: 7000, p95: 33500 },
      upstreamConnectMs: { samples: 0, average: null, p50: null, p95: null },
      upstreamQueueMs: { samples: 0, average: null, p50: null, p95: null },
      upstreamFirstEventMs: {
        samples: 35,
        average: 11300,
        p50: 7000,
        p95: 33500,
      },
      upstreamBodyReadMs: { samples: 0, average: null, p50: null, p95: null },
      adapterPreparationMs: { samples: 35, average: 5, p50: 6, p95: 11 },
      responseTranslationMs: {
        samples: 0,
        average: null,
        p50: null,
        p95: null,
      },
      streamTranslationActiveMs: {
        samples: 0,
        average: null,
        p50: null,
        p95: null,
      },
      downstreamWriteMs: { samples: 35, average: 30, p50: 13, p95: 120 },
      outputToWriteMs: { samples: 35, average: 0, p50: 0, p95: 1 },
      upstreamToOutputMs: { samples: 35, average: 245, p50: 58, p95: 657 },
      responseReadyMs: { samples: 0, average: null, p50: null, p95: null },
    },
  }

  test("filters out empty metrics when hideEmpty is true", () => {
    const view = sandbox.performanceView()
    view.hideEmpty = true

    // 原生请求中，dispatch 阶段没有发生转译和重试
    const dispatchMetrics = view.getStageMetrics(sampleUserRow, "dispatch")
    // 应该只剩下 adapterPreparationMs 和 rateLimitWaitMs (samples: 35)，而 samples 为 0 的被过滤
    expect(dispatchMetrics.map((m: any) => m.field)).toEqual([
      "adapterPreparationMs",
      "rateLimitWaitMs",
    ])

    // 关闭 hideEmpty 时应列出全部
    view.hideEmpty = false
    const allDispatchMetrics = view.getStageMetrics(sampleUserRow, "dispatch")
    expect(allDispatchMetrics.length).toBe(4)
  })

  test("calculates end-to-end pipeline breakdown correctly", () => {
    const view = sandbox.performanceView()
    const breakdown = view.getPipelineBreakdown(sampleUserRow)

    expect(breakdown).toHaveLength(4)
    const [gateway, dispatch, upstream, downstream] = breakdown

    expect(gateway.id).toBe("gateway")
    expect(gateway.ms).toBe(965)
    expect(gateway.pct).toBe(8) // 965 / 12500 ≈ 7.7% -> 8%

    expect(dispatch.id).toBe("dispatch")
    expect(dispatch.ms).toBe(5)
    expect(dispatch.pct).toBe(0)

    expect(upstream.id).toBe("upstream")
    expect(upstream.ms).toBe(11500)
    expect(upstream.pct).toBe(92) // 11500 / 12500 = 92%

    expect(downstream.id).toBe("downstream")
    expect(downstream.ms).toBe(30)
    expect(downstream.pct).toBe(0)
  })

  test("generates smart diagnostic insights from raw performance timings", () => {
    const view = sandbox.performanceView()
    const insights = view.getInsights(sampleUserRow)

    // 1. 上游耗时瓶颈 (92% >= 70%)
    const upstreamInsight = insights.find((i: any) => i.type === "upstream")
    expect(upstreamInsight).toBeDefined()
    expect(upstreamInsight.text).toContain("92%")

    // 2. 客户端网络上传 (928ms / 965ms >= 70%)
    const networkInsight = insights.find((i: any) => i.type === "network")
    expect(networkInsight).toBeDefined()
    expect(networkInsight.text).toContain("928ms")

    // 3. 模型思考时间 (19.2s - 12.5s = 6.7s)
    const thinkingInsight = insights.find((i: any) => i.type === "thinking")
    expect(thinkingInsight).toBeDefined()
    expect(thinkingInsight.text).toContain("6.7s")
  })

  test("supports model/provider search filtering", () => {
    const view = sandbox.performanceView()
    view.details = [
      sampleUserRow,
      {
        ...sampleUserRow,
        model: "claude-3-5-sonnet",
        provider: "anthropic",
      },
    ]

    view.searchQuery = "deepseek"
    expect(view.filteredDetails).toHaveLength(1)
    expect(view.filteredDetails[0].model).toBe("deepseek-v4.1-flash")

    view.searchQuery = "anthropic"
    expect(view.filteredDetails).toHaveLength(1)
    expect(view.filteredDetails[0].model).toBe("claude-3-5-sonnet")

    view.searchQuery = "non-existent"
    expect(view.filteredDetails).toHaveLength(0)
  })

  test("manages stage collapse and expand toggle", () => {
    const view = sandbox.performanceView()
    const key = view.getRowKey(sampleUserRow)

    expect(view.isStageExpanded(key, "gateway")).toBe(false)
    view.toggleStage(key, "gateway")
    expect(view.isStageExpanded(key, "gateway")).toBe(true)

    // 全部展开 / 折叠
    view.toggleAllStages(key)
    expect(view.isAllExpanded(key)).toBe(true)
    view.toggleAllStages(key)
    expect(view.isAllExpanded(key)).toBe(false)
  })

  test("calculates globalStats.avgTps accurately and clamps extreme outliers", () => {
    const view = sandbox.performanceView()

    // 1. 优先使用 performance 数组中的真实模型级吞吐
    view.performance = [
      {
        model: "claude-3-7-sonnet",
        requests: 100,
        streamingRequests: 100,
        avgStreamingTps: 80,
        avgTtftMs: 500,
      },
      {
        model: "gpt-4o",
        requests: 50,
        streamingRequests: 50,
        avgStreamingTps: 100,
        avgTtftMs: 400,
      },
    ]
    // 即使 details 中存在因单帧除以零导致的异常通道 (例如 5000+ tok/s)
    view.details = [
      {
        model: "claude-3-7-sonnet",
        streaming: true,
        generationSamples: 100,
        generationTps: 5954.5, // 离群异常值
      },
    ]

    const stats = view.globalStats
    // 加权均值应为: (80 * 100 + 100 * 50) / 150 = 13000 / 150 ≈ 86.67 tok/s，而不是 5000+
    expect(stats.avgTps).toBeCloseTo(86.67, 1)
    expect(stats.totalSamples).toBe(150)

    // 2. getChannelTps 防护: 离群通道自动回退到模型基准
    const clampedTps = view.getChannelTps(view.details[0])
    expect(clampedTps).toBe(80) // 回退到 claude-3-7-sonnet 的 80 tok/s 基准

    // 3. 当 performance 为空回退到 details 时，>800 tok/s 也会被安全钳位
    view.performance = []
    const fallbackStats = view.globalStats
    expect(fallbackStats.avgTps).toBe(800) // 钳位到上限 800
  })

  test("sorts by decode TPS and explains its narrower sample coverage", () => {
    const view = sandbox.performanceView()
    view.performance = [
      {
        model: "end-to-end-fast",
        requests: 1,
        streamingRequests: 1,
        avgStreamingTps: 200,
        avgDecodeTps: 40,
        decodeSamples: 1,
      },
      {
        model: "decode-fast",
        requests: 1,
        streamingRequests: 1,
        avgStreamingTps: 20,
        avgDecodeTps: 300,
        decodeSamples: 1,
      },
      {
        model: "legacy-only",
        requests: 1,
        streamingRequests: 1,
        avgStreamingTps: 50,
        avgDecodeTps: null,
        decodeSamples: 0,
      },
    ]

    view.sortBy = "decodeTps"
    view.sortDesc = true
    // 两列排序互不影响：端到端最快的行不是解码最快的行
    expect(
      view.sortedModels.map((row: { model: string }) => row.model),
    ).toEqual(["decode-fast", "end-to-end-fast", "legacy-only"])
    view.sortBy = "tps"
    expect(
      view.sortedModels.map((row: { model: string }) => row.model),
    ).toEqual(["end-to-end-fast", "legacy-only", "decode-fast"])

    expect(view.decodeTpsTitle({ decodeSamples: 2, avgDecodeTps: 150 })).toBe(
      "解码速率可用样本 2 条",
    )
    expect(view.decodeTpsTitle({ decodeSamples: 0, avgDecodeTps: null })).toBe(
      "未采集分段性能",
    )
  })
})
