const REDACTION_SVG_NS = "http://www.w3.org/2000/svg"
const REDACTION_MORE_LANE = "__more__"
// Mirrors tokenPattern() in src/lib/redaction/token.ts, including the
// 32-hex suffix earlier versions sent.
const REDACTION_TOKEN_SOURCE = String.raw`\{\{(?:BANK_CARD|PRIVATE_KEY|API_KEY|ID_CARD|PASSWORD|SSN|PASSPORT|IBAN|BIRTHDAY|MAC|SERIAL|USERNAME|HOSTNAME|BUCKET|SECRET|EMAIL|PHONE|TOKEN|HOME|WORD|IP)_(?:[a-z2-7]{16}|[a-z2-7]{8}|[a-f0-9]{32})\}\}`
const REDACTION_KINDS = ["SECRET", "HOME", "WORD", "PERSONAL"]

function redactionKindCounts(counts) {
  return Object.fromEntries(
    REDACTION_KINDS.map((kind) => [
      kind,
      typeof counts?.[kind] === "number" ? Math.max(0, counts[kind]) : 0,
    ]),
  )
}

function redactionAttemptMetadata(attempt) {
  const upstream = attempt.upstream || {}
  return {
    upstream: Object.fromEntries(
      ["id", "name", "protocol", "model"].map((key) => [
        key,
        typeof upstream[key] === "string" ? upstream[key].slice(0, 160) : "",
      ]),
    ),
    status:
      ["running", "returned", "failed"].includes(attempt.status) ?
        attempt.status
      : "running",
    bodies: (attempt.bodies || []).slice(0, 16).map((body) => ({
      places: typeof body.places === "number" ? Math.max(0, body.places) : 0,
      status:
        ["prepared", "response", "failed"].includes(body.status) ?
          body.status
        : "prepared",
      httpStatus:
        typeof body.httpStatus === "number" ? body.httpStatus : undefined,
    })),
    truncated: attempt.truncated === true,
  }
}

function redactionLanes(lanes) {
  const side = (items) =>
    (Array.isArray(items) ? items : [])
      .filter((lane) => lane && typeof lane.id === "string")
      .map((lane) => ({
        id: lane.id,
        name: typeof lane.name === "string" ? lane.name.slice(0, 160) : "",
        count: typeof lane.count === "number" ? Math.max(0, lane.count) : 0,
      }))
  return {
    clients: side(lanes?.clients),
    upstreams: side(lanes?.upstreams),
  }
}

// Animation state lives outside Alpine's reactive proxy: it holds DOM nodes
// and is mutated every frame.
const redactionFlow = {
  layoutKey: "",
  seen: null,
  paths: { client: new Map(), upstream: new Map() },
  svg: null,
  hub: null,
  scan: null,
  height: 0,
  particles: [],
  events: [],
  raf: 0,
}

function redactionSvgAdd(parent, tag, attrs) {
  const node = document.createElementNS(REDACTION_SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, String(value))
  parent.appendChild(node)
  return node
}

function redactionReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

function stopRedactionParticles() {
  if (redactionFlow.raf) cancelAnimationFrame(redactionFlow.raf)
  redactionFlow.raf = 0
  for (const particle of redactionFlow.particles) particle.el.remove()
  redactionFlow.particles = []
  redactionFlow.events = []
}

function resetRedactionFlow() {
  stopRedactionParticles()
  redactionFlow.layoutKey = ""
  redactionFlow.seen = null
}

function spawnRedactionParticle(path, delay, duration, shape) {
  if (!path || !redactionFlow.svg) return
  const el =
    shape === "token" ?
      redactionSvgAdd(redactionFlow.svg, "rect", {
        x: -2.2,
        y: -2.2,
        width: 4.4,
        height: 4.4,
        rx: 1,
        class: "mo-dot out",
      })
    : redactionSvgAdd(redactionFlow.svg, "circle", {
        r: 2.4,
        class: "mo-dot" + (shape === "empty" ? " empty" : ""),
      })
  const length = path.getTotalLength()
  redactionFlow.particles.push({
    el,
    points: Array.from({ length: 33 }, (_, i) =>
      path.getPointAtLength((length * i) / 32),
    ),
    start: performance.now() + delay,
    duration,
  })
  runRedactionFlow()
}

function scheduleRedactionEvent(delay, fire) {
  redactionFlow.events.push({ at: performance.now() + delay, fire })
  runRedactionFlow()
}

function pulseRedactionHub() {
  redactionFlow.hub?.animate(
    [
      { transform: "translate(-50%, -50%) scale(1)" },
      { transform: "translate(-50%, -50%) scale(1.12)" },
      { transform: "translate(-50%, -50%) scale(1)" },
    ],
    { duration: 420, easing: "cubic-bezier(.2, .7, .1, 1)" },
  )
  redactionFlow.scan?.animate(
    [
      { transform: "translateY(0)", opacity: 0 },
      { opacity: 0.9, offset: 0.15 },
      { opacity: 0.9, offset: 0.85 },
      {
        transform: `translateY(${Math.max(10, redactionFlow.height - 38)}px)`,
        opacity: 0,
      },
    ],
    { duration: 900, easing: "cubic-bezier(.45, 0, .55, 1)" },
  )
}

function runRedactionFlow() {
  if (redactionFlow.raf) return
  const tick = (now) => {
    redactionFlow.raf = 0
    if (document.hidden) return stopRedactionParticles()
    redactionFlow.events = redactionFlow.events.filter((event) => {
      if (event.at > now) return true
      event.fire()
      return false
    })
    redactionFlow.particles = redactionFlow.particles.filter((particle) => {
      const t = (now - particle.start) / particle.duration
      if (t >= 1) {
        particle.el.remove()
        return false
      }
      if (t < 0) {
        particle.el.style.opacity = "0"
        return true
      }
      const eased = 1 - Math.pow(1 - t, 2)
      const position = eased * 32
      const index = Math.min(31, Math.floor(position))
      const a = particle.points[index]
      const b = particle.points[index + 1]
      const part = position - index
      const point = { x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part }
      particle.el.setAttribute("transform", `translate(${point.x} ${point.y})`)
      particle.el.style.opacity = String(Math.min(1, t * 8, (1 - t) * 8))
      return true
    })
    if (redactionFlow.particles.length || redactionFlow.events.length)
      redactionFlow.raf = requestAnimationFrame(tick)
  }
  redactionFlow.raf = requestAnimationFrame(tick)
}

function redactionView() {
  return {
    settings: null,
    appliedRedaction: null,
    source: "",
    tab: "overview",
    kindFilter: "all",
    liveActive: false,
    liveTimer: null,
    liveSource: null,
    liveEventTimer: null,
    liveDirty: false,
    motionPaused: false,
    animationPaused: false,
    loading: false,
    saving: false,
    saved: false,
    error: "",
    loadVersion: 0,
    newWordInput: "",
    newPrefixInput: "",
    redactionWordsText: "",
    redactionHomePrefixesText: "",
    allowText: "",
    history: null,
    historyDays: 14,
    historyError: "",
    historyVersion: 0,
    personalKinds: [
      { id: "EMAIL", nameKey: "system.redaction.personalKind.EMAIL" },
      { id: "PHONE", nameKey: "system.redaction.personalKind.PHONE" },
      { id: "ID_CARD", nameKey: "system.redaction.personalKind.ID_CARD" },
      { id: "BANK_CARD", nameKey: "system.redaction.personalKind.BANK_CARD" },
      { id: "IP", nameKey: "system.redaction.personalKind.IP" },
      { id: "SSN", nameKey: "system.redaction.personalKind.SSN" },
      { id: "PASSPORT", nameKey: "system.redaction.personalKind.PASSPORT" },
      { id: "IBAN", nameKey: "system.redaction.personalKind.IBAN" },
      { id: "BIRTHDAY", nameKey: "system.redaction.personalKind.BIRTHDAY" },
      { id: "MAC", nameKey: "system.redaction.personalKind.MAC" },
      { id: "SERIAL", nameKey: "system.redaction.personalKind.SERIAL" },
      { id: "USERNAME", nameKey: "system.redaction.personalKind.USERNAME" },
      { id: "HOSTNAME", nameKey: "system.redaction.personalKind.HOSTNAME" },
      { id: "BUCKET", nameKey: "system.redaction.personalKind.BUCKET" },
    ],
    redactionCategories: [
      { id: "SECRET", nameKey: "system.redaction.SECRET" },
      { id: "HOME", nameKey: "system.redaction.HOME" },
      { id: "WORD", nameKey: "system.redaction.WORD" },
      { id: "PERSONAL", nameKey: "system.redaction.PERSONAL" },
    ],
    previewText: "",
    previewFormat: "text",
    previewResult: null,
    previewError: "",
    previewLoading: false,
    previewStale: false,
    previewVersion: 0,
    previewController: null,
    redactionStats: [],
    redactionStatsLoading: false,
    redactionStatsError: "",
    redactionTotalRequests: 0,
    redactionLanes: { clients: [], upstreams: [] },
    statsUpdatedAt: null,
    statsVersion: 0,
    statsController: null,
    clientFilter: null,
    upstreamFilter: null,
    inspection: { enabled: false, expiresAt: null },
    inspectionTimer: null,
    inspectionBusy: false,
    inspectionVersion: 0,
    inspectionController: null,
    detailId: null,
    detail: null,
    detailRevealed: false,
    detailViewMode: "both",
    detailLoading: false,
    detailError: "",
    detailVersion: 0,
    detailContentVersion: 0,
    detailController: null,
    activePlaceholder: null,

    init() {
      for (const field of [
        "previewText",
        "previewFormat",
        "settings",
        "redactionWordsText",
        "redactionHomePrefixesText",
        "allowText",
      ])
        this.$watch(field, () => this.invalidatePreview())
    },

    accept(data) {
      this.invalidatePreview()
      this.appliedRedaction = data.settings.redaction
      this.settings = { redaction: { ...data.settings.redaction } }
      if (!Array.isArray(this.settings.redaction.words)) {
        this.settings.redaction.words = []
      }
      if (!Array.isArray(this.settings.redaction.homePrefixes)) {
        this.settings.redaction.homePrefixes = []
      }
      this.redactionWordsText = this.settings.redaction.words.join("\n")
      this.redactionHomePrefixesText =
        this.settings.redaction.homePrefixes.join("\n")
      this.settings.redaction.personalKinds = {
        ...this.settings.redaction.personalKinds,
      }
      this.settings.redaction.actions = { ...this.settings.redaction.actions }
      this.allowText = (this.settings.redaction.allow || []).join("\n")
      this.source = data.source
    },

    addWord() {
      const val = (this.newWordInput || "").trim()
      if (!val) return
      if (!this.settings?.redaction) return
      if (!this.settings.redaction.words) this.settings.redaction.words = []
      if (!this.settings.redaction.words.includes(val)) {
        this.settings.redaction.words.push(val)
        this.redactionWordsText = this.settings.redaction.words.join("\n")
        this.saved = false
        this.invalidatePreview()
      }
      this.newWordInput = ""
    },

    removeWord(index) {
      if (!this.settings?.redaction?.words) return
      this.settings.redaction.words.splice(index, 1)
      this.redactionWordsText = this.settings.redaction.words.join("\n")
      this.saved = false
      this.invalidatePreview()
    },

    addHomePrefix() {
      const val = (this.newPrefixInput || "").trim()
      if (!val) return
      if (!this.settings?.redaction) return
      if (!this.settings.redaction.homePrefixes)
        this.settings.redaction.homePrefixes = []
      if (!this.settings.redaction.homePrefixes.includes(val)) {
        this.settings.redaction.homePrefixes.push(val)
        this.redactionHomePrefixesText =
          this.settings.redaction.homePrefixes.join("\n")
        this.saved = false
        this.invalidatePreview()
      }
      this.newPrefixInput = ""
    },

    removeHomePrefix(index) {
      if (!this.settings?.redaction?.homePrefixes) return
      this.settings.redaction.homePrefixes.splice(index, 1)
      this.redactionHomePrefixesText =
        this.settings.redaction.homePrefixes.join("\n")
      this.saved = false
      this.invalidatePreview()
    },

    enterRedaction() {
      this.liveActive = true
      resetRedactionFlow()
      void this.load()
      this.syncLive()
      this.initTopologyMotion()
    },

    syncLive() {
      if (this.liveTimer !== null) clearTimeout(this.liveTimer)
      this.liveTimer = null
      this.motionPaused = !this.liveActive || document.hidden
      if (this.motionPaused) {
        this.stopLiveEvents()
        // Requests missed while hidden must not replay as if they were live.
        resetRedactionFlow()
        this.clearDetail()
        this.clearPreview()
        this.cancelInspectionRequest()
        this.statsVersion++
        this.statsController?.abort()
        this.statsController = null
        this.redactionStatsLoading = false
        return
      }
      this.startLiveEvents()
      this.liveTimer = setTimeout(async () => {
        this.liveTimer = null
        await this.loadRedactionStats(true)
        this.syncLive()
      }, 2500)
    },

    stopLiveEvents() {
      this.liveSource?.close()
      this.liveSource = null
      if (this.liveEventTimer !== null) clearTimeout(this.liveEventTimer)
      this.liveEventTimer = null
      this.liveDirty = false
    },

    startLiveEvents() {
      if (this.liveSource || typeof EventSource === "undefined") return
      const source = new EventSource(
        `${API.baseUrl}/system-config/redaction-events`,
      )
      this.liveSource = source
      source.addEventListener("change", () => {
        if (source !== this.liveSource) return
        this.liveDirty = true
        this.queueLiveRefresh()
      })
    },

    queueLiveRefresh() {
      if (this.liveEventTimer !== null || this.statsController) return
      this.liveEventTimer = setTimeout(async () => {
        this.liveEventTimer = null
        if (!this.liveActive || document.hidden || !this.liveSource) return
        if (this.statsController) return
        this.liveDirty = false
        await this.loadRedactionStats(true)
      }, 50)
    },

    async load() {
      const version = ++this.loadVersion
      this.loading = true
      this.error = ""
      this.saved = false
      void this.loadRedactionStats()
      void this.loadHistory()
      try {
        const data = await API.request("/system-config")
        if (version === this.loadVersion) this.accept(data)
      } catch (error) {
        if (version === this.loadVersion) this.error = error.message
      } finally {
        if (version === this.loadVersion) this.loading = false
      }
    },

    async toggleMainSwitch() {
      if (!this.settings?.redaction || this.saving || this.loading) return
      const previous = !!this.settings.redaction.enabled
      const target = !previous
      this.settings.redaction.enabled = target
      this.saving = true
      this.error = ""
      this.saved = false
      try {
        const data = await API.request("/system-config/redaction-config", {
          method: "PUT",
          body: this.draftRedactionConfig(),
        })
        this.accept(data)
        this.saved = true
      } catch (error) {
        this.settings.redaction.enabled = previous
        this.error = error.message || I18n.t("redaction.error.toggle")
      } finally {
        this.saving = false
      }
    },

    async save() {
      this.saving = true
      this.error = ""
      this.saved = false
      try {
        this.accept(
          await API.request("/system-config/redaction-config", {
            method: "PUT",
            body: this.draftRedactionConfig(),
          }),
        )
        this.saved = true
      } catch (error) {
        this.error = error.message
      } finally {
        this.saving = false
      }
    },

    draftRedactionConfig() {
      const lines = (text) =>
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      // The texts are the drafts; the tag chips edit them through addWord /
      // removeWord, so a cleared or invalid draft is what gets saved.
      return {
        ...this.settings.redaction,
        words: lines(this.redactionWordsText),
        homePrefixes: lines(this.redactionHomePrefixesText),
        allow: lines(this.allowText),
      }
    },

    previewKey() {
      return JSON.stringify([
        this.previewText,
        this.previewFormat,
        this.draftRedactionConfig(),
      ])
    },

    invalidatePreview() {
      this.previewStale =
        this.previewStale || !!this.previewResult || this.previewLoading
      this.previewVersion++
      this.previewController?.abort()
      this.previewController = null
      this.previewLoading = false
      this.previewResult = null
      this.previewError = ""
    },

    clearPreview() {
      this.invalidatePreview()
      this.previewText = ""
      this.previewStale = false
    },

    samplePreview() {
      this.clearPreview()
      const sample = {
        password: ["synthetic", "demo", "password123"].join("-"),
        path: ["/Users", "synthetic-user", "project/file.txt"].join("/"),
        note: "internal.example",
      }
      this.previewText =
        this.previewFormat === "json" ?
          JSON.stringify(sample, null, 2)
        : `DB_PASSWORD=${sample.password}\n${sample.path}\n${sample.note}`
      void this.runRedactionPreview()
    },

    async runRedactionPreview() {
      this.invalidatePreview()
      this.previewStale = false
      if (!this.previewText) return
      if (this.previewText.length > 65536) {
        this.previewError = "system.redaction.previewTooLarge"
        return
      }
      const version = this.previewVersion
      const key = this.previewKey()
      const controller = new AbortController()
      this.previewController = controller
      this.previewLoading = true
      try {
        const result = await API.request("/system-config/redaction-preview", {
          method: "POST",
          signal: controller.signal,
          body: {
            text: this.previewText,
            format: this.previewFormat,
            config: this.draftRedactionConfig(),
          },
        })
        if (version === this.previewVersion && key === this.previewKey())
          this.previewResult = result
      } catch {
        if (version === this.previewVersion && key === this.previewKey())
          this.previewError = "system.redaction.previewError"
      } finally {
        if (version === this.previewVersion) {
          this.previewLoading = false
          this.previewController = null
        }
      }
    },

    leaveRedaction() {
      this.liveActive = false
      this.stopLiveEvents()
      resetRedactionFlow()
      if (this.topologyObserver) {
        this.topologyObserver.disconnect()
        this.topologyObserver = null
      }
      this.motionPaused = true
      this.clearDetail()
      this.cancelInspectionRequest()
      if (this.inspectionTimer !== null) clearTimeout(this.inspectionTimer)
      this.inspectionTimer = null
      if (this.liveTimer !== null) clearTimeout(this.liveTimer)
      this.liveTimer = null
      this.loadVersion++
      this.loading = false
      this.clearPreview()
      this.statsVersion++
      this.statsController?.abort()
      this.statsController = null
      this.redactionStatsLoading = false
    },

    destroy() {
      this.leaveRedaction()
    },

    async loadRedactionStats(background = false) {
      if (this.inspectionBusy) return
      this.statsController?.abort()
      const version = ++this.statsVersion
      const controller = new AbortController()
      this.statsController = controller
      this.redactionStatsLoading = !background
      try {
        const data = await API.request("/system-config/redaction-stats", {
          signal: controller.signal,
          cache: "no-store",
        })
        if (version === this.statsVersion) {
          this.redactionStatsError = ""
          this.statsUpdatedAt = Date.now()
          const previousTerminal = this.redactionStats
            .filter((entry) => entry.status !== "in_progress")
            .map((entry) => entry.id)
            .join(",")
          const entries = Array.isArray(data.entries) ? data.entries : []
          const total = Number(data.totalRequests)
          this.redactionTotalRequests = Number.isFinite(total) ? total : 0
          this.redactionLanes = redactionLanes(data.lanes)
          this.acceptInspection(data.inspection)
          this.redactionStats = entries.map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            status:
              (
                ["in_progress", "completed", "failed", "cancelled"].includes(
                  entry.status,
                )
              ) ?
                entry.status
              : "completed",
            client: typeof entry.client === "string" ? entry.client : "",
            upstreams: (entry.upstreams || []).map((upstream) => ({
              id: upstream.id,
              name: upstream.name,
              protocol: upstream.protocol,
              model: upstream.model,
            })),
            contentAvailable: entry.contentAvailable === true,
            contentState:
              entry.contentState
              || (entry.contentAvailable ? "available" : "not_collected"),
            contentVersion: entry.contentVersion || 0,
            attempts: (entry.attempts || [])
              .slice(0, 16)
              .map(redactionAttemptMetadata),
            attemptsTruncated: entry.attemptsTruncated === true,
            detected:
              entry.detected
              ?? entry.total
                + (entry.warned || 0)
                + (entry.blocked?.length || 0),
            detectedByKind: redactionKindCounts(
              entry.detectedByKind || entry.byKind,
            ),
            warnedByKind: redactionKindCounts(entry.warnedByKind),
            blockedByKind: redactionKindCounts(entry.blockedByKind),
            total: entry.total,
            byKind: Object.fromEntries(
              REDACTION_KINDS.map((kind) => [kind, entry.byKind[kind] || 0]),
            ),
            bySource: Object.fromEntries(
              ["builtin", "word", "homePrefix", "field", "known"].map(
                (source) => [source, entry.bySource[source] || 0],
              ),
            ),
            warned: entry.warned || 0,
            blocked:
              entry.blockedCount
              ?? (Array.isArray(entry.blocked) ? entry.blocked.length : 0),
            maskingMs: entry.maskingMs,
            restored: entry.restored,
          }))
          const terminal = this.redactionStats
            .filter((entry) => entry.status !== "in_progress")
            .map((entry) => entry.id)
            .join(",")
          if (terminal !== previousTerminal) void this.loadHistory()
          this.$nextTick(() => {
            this.renderTopologySvg()
            this.emitFlow()
          })
          if (
            this.detailId !== null
            && (!this.inspection.enabled
              || !this.redactionStats.some(
                (entry) => entry.id === this.detailId && entry.contentAvailable,
              ))
          )
            this.clearDetail()
          else if (this.detailId !== null && !this.detailLoading) {
            const entry = this.detailDiagnostics
            if (entry?.contentVersion > this.detailContentVersion)
              void this.loadDetail(this.detailId, this.detailRevealed, true)
          }
        }
      } catch {
        if (version === this.statsVersion)
          this.redactionStatsError = "system.redaction.statsError"
      } finally {
        if (version === this.statsVersion) {
          this.redactionStatsLoading = false
          this.statsController = null
          if (this.liveDirty && this.liveActive && !document.hidden)
            this.queueLiveRefresh()
        }
      }
    },

    get redactionStatsTotal() {
      return this.redactionStats.reduce((sum, entry) => sum + entry.total, 0)
    },

    get distinctValuesTotal() {
      return this.redactionStatsTotal
    },

    get avgMaskingMs() {
      if (!this.redactionStats.length) return "0.00"
      const totalMs = this.redactionStats.reduce(
        (sum, entry) => sum + (entry.maskingMs || 0),
        0,
      )
      return (totalMs / this.redactionStats.length).toFixed(2)
    },

    async loadHistory() {
      const version = ++this.historyVersion
      try {
        const data = await API.request(
          `/system-config/redaction-history?days=${this.historyDays}`,
          { cache: "no-store" },
        )
        if (version === this.historyVersion) {
          this.history = data
          this.historyError = ""
        }
      } catch {
        if (version === this.historyVersion)
          this.historyError = I18n.t("redaction.error.history")
      }
    },

    setHistoryDays(days) {
      if (this.historyDays === days) return
      this.historyDays = days
      this.history = null
      void this.loadHistory()
    },

    // Per-day totals from the on-disk history, so the strip survives restarts.
    get activityDays() {
      const days = this.history?.days || []
      const max = Math.max(1, ...days.map((day) => day.total))
      return days.map((day, i) => {
        const isToday = i === days.length - 1
        const [, month, date] = day.day.split("-").map(Number)
        const dayLabel =
          isToday ?
            I18n.t("redaction.history.today")
          : I18n.t("redaction.history.monthDay", { month, date })
        return {
          key: day.day,
          dayLabel,
          count: day.total,
          heightPct:
            day.total > 0 ?
              Math.max(18, Math.round((day.total / max) * 100))
            : 0,
          hasData: day.total > 0,
          isToday,
          tooltip:
            I18n.t("redaction.history.tooltip", {
              day: dayLabel,
              total: day.total,
              requests: day.requests,
            })
            + (day.warned ?
              I18n.t("redaction.history.tooltipWarned", { warned: day.warned })
            : "")
            + (day.blocked ?
              I18n.t("redaction.history.tooltipBlocked", {
                blocked: day.blocked,
              })
            : ""),
        }
      })
    },

    // Lifetime lanes come from the server: the recent window below evicts
    // records, so counting them here would freeze every lane at the limit.
    routeGroups(side) {
      return side === "client" ?
          this.redactionLanes.clients
        : this.redactionLanes.upstreams
    },

    // At most three lanes per side; the rest share one "others" lane so the
    // drawn weights still add up to every recorded request.
    laneGroups(side) {
      const groups = this.routeGroups(side)
      if (groups.length <= 3) return groups
      const rest = groups.slice(2)
      return [
        ...groups.slice(0, 2),
        {
          id: REDACTION_MORE_LANE,
          name: I18n.t("redaction.routes.others", { count: rest.length }),
          count: rest.reduce((sum, item) => sum + item.count, 0),
          more: true,
        },
      ]
    },

    get displayEndpoints() {
      const lane = (side, item) => ({
        id: item.id,
        name:
          item.more ?
            item.name
          : item.name
            || item.id
            || (side === "client" ?
              I18n.t("redaction.routes.unknownClient")
            : I18n.t("redaction.routes.unknownUpstream")),
        count: I18n.t("redaction.routes.associations", { count: item.count }),
        weight: item.count,
        more: !!item.more,
      })
      const clients = this.laneGroups("client").map((item) =>
        lane("client", item),
      )
      const upstreams = this.laneGroups("upstream").map((item) =>
        lane("upstream", item),
      )
      return { clients, upstreams, isLive: clients.length > 0 }
    },

    topologyObserver: null,

    initTopologyMotion() {
      this.$nextTick(() => {
        const midEl = document.getElementById("redactionMidCanvas")
        if (!midEl) return
        if (this.topologyObserver) {
          this.topologyObserver.disconnect()
          this.topologyObserver = null
        }
        this.renderTopologySvg()
        this.topologyObserver = new ResizeObserver(() => {
          this.renderTopologySvg()
        })
        this.topologyObserver.observe(midEl)
      })
    },

    // Static layer: one hairline bundle per real lane, thickness by request
    // count. Redrawn only when lanes or their measured positions change, so
    // the 2.5 s poll never restarts particles already in flight.
    renderTopologySvg() {
      const midEl = document.getElementById("redactionMidCanvas")
      if (!midEl) return
      const svgEl = midEl.querySelector("svg.mo-svg")
      if (!svgEl) return
      const W = Math.round(midEl.clientWidth)
      const H = Math.round(midEl.clientHeight) || 160
      if (!W || !H) return

      const { clients, upstreams } = this.displayEndpoints
      const flowEl = midEl.closest(".mo-flow")
      const midTop = midEl.getBoundingClientRect().top
      const laneY = (side, item, i, n) => {
        const column = flowEl?.querySelector(
          side === "client" ? ".mo-col:not(.provider)" : ".mo-col.provider",
        )
        const node = [...(column?.querySelectorAll("[data-lane]") || [])].find(
          (el) => el.dataset.lane === item.id,
        )
        if (node) {
          const rect = node.getBoundingClientRect()
          return Math.round(rect.top + rect.height / 2 - midTop)
        }
        return Math.round((H - n * 40) / 2 + (i + 0.5) * 40)
      }
      const lanes = (side, items) =>
        items.map((item, i) => ({
          id: item.id,
          weight: item.weight,
          y: laneY(side, item, i, items.length),
        }))
      const left = lanes("client", clients)
      const right = lanes("upstream", upstreams)
      const key = JSON.stringify([
        W,
        H,
        left.map(({ id, y }) => ({ id, y })),
        right.map(({ id, y }) => ({ id, y })),
      ])
      const max = Math.max(
        1,
        ...left.map((l) => l.weight),
        ...right.map((l) => l.weight),
      )
      const updateWeights = () => {
        for (const [side, lanes] of [
          ["client", left],
          ["upstream", right],
        ])
          for (const lane of lanes)
            redactionFlow.paths[side]
              .get(lane.id)
              ?.style.setProperty(
                "stroke-width",
                String(0.75 + (2.25 * lane.weight) / max),
              )
      }
      if (key === redactionFlow.layoutKey && svgEl.firstChild) {
        updateWeights()
        return
      }
      redactionFlow.layoutKey = key

      svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`)
      const staticLayer =
        svgEl.querySelector(".mo-static")
        || redactionSvgAdd(svgEl, "g", { class: "mo-static" })
      staticLayer.replaceChildren()
      const particleLayer =
        svgEl.querySelector(".mo-particles")
        || redactionSvgAdd(svgEl, "g", { class: "mo-particles" })
      redactionFlow.paths = { client: new Map(), upstream: new Map() }
      redactionFlow.svg = particleLayer
      redactionFlow.hub = midEl.querySelector(".msk-hub")
      redactionFlow.height = H

      const m = W / 2
      const curve = (x0, y0, x1, y1) =>
        `M${x0},${y0}C${(x0 + x1) / 2},${y0} ${(x0 + x1) / 2},${y1} ${x1},${y1}`

      redactionSvgAdd(staticLayer, "line", {
        x1: m,
        y1: 8,
        x2: m,
        y2: H - 8,
        class: "mo-mem",
      })
      for (let y = 16; y <= H - 16; y += 18)
        redactionSvgAdd(staticLayer, "line", {
          x1: m - 4,
          y1: y,
          x2: m + 4,
          y2: y,
          class: "mo-tick",
        })
      redactionFlow.scan = redactionSvgAdd(staticLayer, "rect", {
        x: m - 1.5,
        y: 8,
        width: 3,
        height: 22,
        rx: 1.5,
        class: "mo-scan",
      })

      const bundle = (side, items) => {
        const out = side === "upstream"
        for (const lane of items) {
          const d =
            out ? curve(m, H / 2, W, lane.y) : curve(0, lane.y, m, H / 2)
          const path = redactionSvgAdd(staticLayer, "path", {
            d,
            class: "mo-th" + (out ? " out" : ""),
          })
          redactionFlow.paths[side].set(lane.id, path)
        }
      }
      bundle("client", left)
      bundle("upstream", right)
      updateWeights()
    },

    // Play animation for a single record flowing through proxy hub
    playRecordFlow(entry, offsetDelay = 0) {
      if (!entry || document.hidden || redactionReducedMotion()) return
      const laneOf = (side, id) =>
        redactionFlow.paths[side]?.get(id)
        ?? redactionFlow.paths[side]?.get(REDACTION_MORE_LANE)
        ?? redactionFlow.paths[side]?.values().next().value
      const travel = 900
      const gap = 90
      const dots = Math.max(1, Math.min(4, entry.total || 0))
      const shape = entry.total ? "value" : "empty"
      const inPath = laneOf("client", entry.client)
      for (let d = 0; d < dots; d++)
        spawnRedactionParticle(inPath, offsetDelay + d * gap, travel, shape)
      const arrive = offsetDelay + travel + (dots - 1) * gap
      scheduleRedactionEvent(arrive, pulseRedactionHub)
      const targets =
        entry.upstreams?.length ?
          [...new Set(entry.upstreams.map((u) => u.id || ""))]
        : [""]
      for (const target of targets) {
        const outPath = laneOf("upstream", target)
        for (let d = 0; d < dots; d++)
          spawnRedactionParticle(
            outPath,
            arrive + 120 + d * gap,
            travel,
            entry.total ? "token" : "empty",
          )
      }
    },

    // Dispatch can arrive after the initial record, including on older live
    // requests. Remember each upstream per record so completion cannot replay it.
    emitFlow() {
      const first = redactionFlow.seen === null
      const previous = redactionFlow.seen || new Map()
      const next = new Map()
      let count = 0
      for (const entry of [...this.redactionStats].reverse()) {
        const seen = previous.get(entry.id) || new Set()
        const fresh = entry.upstreams.filter(
          (upstream) => !seen.has(upstream.id),
        )
        next.set(
          entry.id,
          new Set(entry.upstreams.map((upstream) => upstream.id)),
        )
        if (first && entry.status !== "in_progress") continue
        if (
          fresh.length
          && count < 8
          && !document.hidden
          && !redactionReducedMotion()
        )
          this.playRecordFlow({ ...entry, upstreams: fresh }, count++ * 100)
      }
      redactionFlow.seen = next
    },

    get routeFilteredRecords() {
      return this.redactionStats.filter((entry) => {
        const matchesClient =
          this.clientFilter === null || entry.client === this.clientFilter
        const matchesUpstream =
          this.upstreamFilter === null
          || (entry.upstreams.length ?
            entry.upstreams.some(
              (item) => (item.id || "") === this.upstreamFilter,
            )
          : this.upstreamFilter === "")
        return matchesClient && matchesUpstream
      })
    },

    get filteredRecords() {
      return this.routeFilteredRecords.filter(
        (entry) =>
          !this.kindFilter
          || this.kindFilter === "all"
          || this.entryKindCount(entry, this.kindFilter) > 0,
      )
    },

    entryKindCount(entry, kind) {
      return (entry.detectedByKind || entry.byKind)?.[kind] || 0
    },

    entryKindBadges(entry) {
      return REDACTION_KINDS.filter(
        (kind) => this.entryKindCount(entry, kind) > 0,
      ).map((kind) => ({
        kind,
        label: I18n.t("redaction.records.kindValues", {
          kind: I18n.t("system.redaction." + kind),
          count: this.entryKindCount(entry, kind),
        }),
        title: I18n.t("redaction.records.kindActions", {
          masked: entry.byKind?.[kind] || 0,
          warned: entry.warnedByKind?.[kind] || 0,
          blocked: entry.blockedByKind?.[kind] || 0,
        }),
      }))
    },

    entryStatusClass(entry) {
      if (entry.status === "failed") return "bg-[var(--apple-red)]"
      if (entry.status === "in_progress") return "bg-[var(--apple-blue)]"
      if (entry.status === "cancelled") return "bg-[var(--apple-orange)]"
      return "bg-[var(--apple-gray)]"
    },

    entryActionSummary(entry) {
      return I18n.t("redaction.records.actions", {
        masked: entry.total || 0,
        warned: entry.warned || 0,
        blocked: entry.blocked || 0,
      })
    },

    formatUpstreams(entry) {
      return (
        entry.upstreams
          .map((upstream) => upstream.name || upstream.id)
          .join(I18n.t("listSeparator")) || I18n.t("redaction.routes.unknown")
      )
    },

    formatDateGroup(timestamp) {
      const d = new Date(timestamp)
      const now = new Date()
      if (d.toDateString() === now.toDateString())
        return I18n.t("redaction.history.todayLabel")
      const yesterday = new Date(now)
      yesterday.setDate(now.getDate() - 1)
      if (d.toDateString() === yesterday.toDateString())
        return I18n.t("redaction.history.yesterday")
      return I18n.t("redaction.history.monthDay", {
        month: d.getMonth() + 1,
        date: d.getDate(),
      })
    },

    formatTimeOnly(timestamp) {
      if (!timestamp) return ""
      const d = new Date(timestamp)
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    },

    get groupedRecords() {
      const groups = []
      let currentGroup = null
      for (const entry of this.filteredRecords) {
        const groupName = this.formatDateGroup(entry.timestamp)
        if (!currentGroup || currentGroup.dateLabel !== groupName) {
          currentGroup = { dateLabel: groupName, records: [] }
          groups.push(currentGroup)
        }
        currentGroup.records.push(entry)
      }
      return groups
    },

    filterRoute(side, id) {
      const field = side === "client" ? "clientFilter" : "upstreamFilter"
      this[field] = this[field] === id ? null : id
      this.tab = "overview"
      this.clearDetail()
    },

    clearDetail() {
      this.detailVersion++
      this.detailController?.abort()
      this.detailController = null
      this.detailId = null
      this.detailContentVersion = 0
      this.detail = null
      this.detailRevealed = false
      this.detailViewMode = "both"
      this.detailLoading = false
      this.detailError = ""
      this.activePlaceholder = null
    },

    acceptInspection(value) {
      if (this.inspectionTimer !== null) clearTimeout(this.inspectionTimer)
      this.inspectionTimer = null
      this.inspection = {
        enabled: value?.enabled === true,
        expiresAt: value?.expiresAt ?? null,
        ttlMs: value?.ttlMs,
        maxBytes: value?.maxBytes,
        maxEntryBytes: value?.maxEntryBytes,
        bytes: value?.bytes ?? 0,
        mode:
          value?.mode
          || (value?.enabled ?
            value?.expiresAt ?
              "temporary"
            : "continuous"
          : "off"),
      }
      if (!this.inspection.enabled) {
        this.clearDetail()
        return
      }
      if (this.inspection.expiresAt) {
        const remaining =
          new Date(this.inspection.expiresAt).getTime() - Date.now()
        if (remaining <= 0) {
          this.inspection.enabled = false
          this.clearDetail()
          return
        }
        this.inspectionTimer = setTimeout(() => {
          this.inspection.enabled = false
          this.inspectionTimer = null
          this.clearDetail()
        }, remaining)
      }
    },

    get inspectionSummary() {
      const state = this.inspection
      const mode =
        !state.enabled ? "off"
        : state.expiresAt ? "temporary"
        : "continuous"
      return I18n.t("redaction.inspect.policy." + mode, {
        expires:
          state.expiresAt ? new Date(state.expiresAt).toLocaleTimeString() : "",
        max: ((state.maxBytes || 0) / 1024 / 1024).toFixed(0),
        entry: ((state.maxEntryBytes || 0) / 1024).toFixed(0),
      })
    },

    cancelInspectionRequest() {
      this.inspectionVersion++
      this.inspectionController?.abort()
      this.inspectionController = null
      this.inspectionBusy = false
    },

    async changeInspection(action) {
      this.clearDetail()
      this.cancelInspectionRequest()
      this.statsVersion++
      this.statsController?.abort()
      this.redactionStatsLoading = false
      const version = this.inspectionVersion
      const controller = new AbortController()
      this.inspectionController = controller
      this.inspectionBusy = true
      try {
        const data = await API.request(
          action === "clear" ?
            "/system-config/redaction-records"
          : "/system-config/redaction-inspection",
          {
            method: action === "clear" ? "DELETE" : "POST",
            ...(action === "clear" ?
              {}
            : {
                body: {
                  enabled: action !== "disable",
                  ...(action === "temporary" ? { mode: "temporary" } : {}),
                },
              }),
            signal: controller.signal,
            cache: "no-store",
          },
        )
        if (version !== this.inspectionVersion) return
        this.acceptInspection(data.inspection || data)
        if (
          action === "disable"
          || action === "clear"
          || action === "temporary"
        )
          this.redactionStats.forEach((entry) => {
            entry.contentAvailable = false
          })
      } catch {
        if (version === this.inspectionVersion) {
          this.inspection.enabled = false
          this.detailError = "redaction.inspect.error"
        }
      } finally {
        if (version === this.inspectionVersion) {
          this.inspectionBusy = false
          this.inspectionController = null
        }
      }
    },

    async selectDetailViewMode(mode) {
      if (
        !["both", "vendor", "original"].includes(mode)
        || this.detailLoading
        || this.detailId === null
      )
        return
      const id = this.detailId
      if (mode !== "vendor" && !this.detailRevealed) {
        if (!this.detail?.mappings.length) return
        await this.loadDetail(id, true, true)
        if (this.detailId !== id || !this.detailRevealed) return
      }
      this.detailViewMode = mode
    },

    async loadDetail(id, reveal = false, refresh = false) {
      if (!refresh) this.clearDetail()
      else {
        this.detailVersion++
        this.detailController?.abort()
      }
      const entry = this.redactionStats.find((item) => item.id === id)
      if (!entry) return
      this.detailId = id
      if (
        !this.inspection.enabled
        || this.inspectionBusy
        || (this.inspection.expiresAt
          && new Date(this.inspection.expiresAt).getTime() <= Date.now())
        || !entry.contentAvailable
      ) {
        this.detail = {
          id,
          input: null,
          attempts: [],
          mappings: [],
          truncated: false,
          version: 0,
        }
        this.detailRevealed = false
        this.detailLoading = false
        return
      }
      this.detailContentVersion = entry.contentVersion || 0
      const version = this.detailVersion
      const controller = new AbortController()
      this.detailController = controller
      this.detailLoading = true
      try {
        const data = await API.request(
          `/system-config/redaction-records/${encodeURIComponent(id)}${reveal ? "?reveal=1" : ""}`,
          { signal: controller.signal, cache: "no-store" },
        )
        if (version !== this.detailVersion || this.detailId !== id) return
        this.detail = {
          id: data.id,
          version: data.version || 0,
          input: null,
          attempts: data.attempts.map((attempt) => ({
            upstream: {
              id: attempt.upstream.id,
              name: attempt.upstream.name,
              protocol: attempt.upstream.protocol,
              model: attempt.upstream.model,
            },
            stage: attempt.stage,
            body: attempt.body,
            truncated: attempt.truncated,
            parts: this.contentParts(
              attempt.body,
              data.mappings,
              attempt.excerpts,
            ),
          })),
          mappings: data.mappings.map((mapping) => ({
            placeholder: mapping.placeholder,
            kind: mapping.kind,
            label: mapping.label,
            source: mapping.source,
            truncated: mapping.truncated === true,
            ...(reveal ? { value: mapping.value } : {}),
          })),
          truncated: data.truncated,
        }
        this.detailContentVersion = data.version || entry.contentVersion || 0
        this.detailError = ""
        this.detailRevealed = reveal
        if (!refresh) this.detailViewMode = reveal ? "both" : "vendor"
      } catch {
        if (version === this.detailVersion) {
          this.detailError = "redaction.inspect.error"
          if (refresh) this.detailContentVersion = 0
        }
      } finally {
        if (version === this.detailVersion) {
          this.detailLoading = false
          this.detailController = null
        }
      }
    },

    detailClientName() {
      const entry = this.redactionStats.find((e) => e.id === this.detailId)
      return entry?.client || I18n.t("redaction.routes.fromClient")
    },

    get detailDiagnostics() {
      return this.redactionStats.find((entry) => entry.id === this.detailId)
    },

    get detailDetectionSummary() {
      const entry = this.detailDiagnostics
      if (!entry) return I18n.t("redaction.inspect.countUnknown")
      return I18n.t("redaction.inspect.detected", {
        count: entry.detected ?? entry.total,
      })
    },

    get detailMaskingSummary() {
      const entry = this.detailDiagnostics
      if (!entry) return I18n.t("redaction.inspect.countUnknown")
      if (entry.total > 0)
        return I18n.t("redaction.inspect.maskedCount", {
          count: entry.total,
          home: entry.byKind.HOME || 0,
        })
      return I18n.t("redaction.inspect.noReplacements")
    },

    get detailContentState() {
      return (
        this.detailDiagnostics?.contentState
        || (this.detailDiagnostics?.contentAvailable ?
          "available"
        : "not_collected")
      )
    },

    get detailAttemptSummary() {
      const attempts = this.detailDiagnostics?.attempts || []
      const bodies = attempts.flatMap((attempt) => attempt.bodies || [])
      return I18n.t("redaction.inspect.attemptSummary", {
        attempts: attempts.length,
        bodies: bodies.length,
        places: bodies.reduce((sum, body) => sum + body.places, 0),
      })
    },

    get detailFacts() {
      const entry = this.detailDiagnostics
      if (!entry) return []
      return [
        {
          label: "redaction.facts.request",
          value: I18n.t("redaction.status." + entry.status),
        },
        {
          label: "redaction.facts.detection",
          value: this.detailDetectionSummary,
        },
        {
          label: "redaction.facts.action",
          value: this.entryActionSummary(entry),
        },
        {
          label: "redaction.facts.restoration",
          value: I18n.t("redaction.facts.restoredCount", {
            count: entry.restored || 0,
          }),
        },
        {
          label: "redaction.facts.evidence",
          value: I18n.t("redaction.content." + this.detailContentState),
        },
      ]
    },

    contentParts(body, mappings, excerpts = []) {
      const known = new Set(mappings.map((mapping) => mapping.placeholder))
      const leaves = []
      const visit = (value, path, role) => {
        if (typeof value === "string") {
          leaves.push({ path, role, text: value })
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, `${path}[${index}]`, role))
        } else if (value && typeof value === "object") {
          const owner = typeof value.role === "string" ? value.role : role
          for (const [key, item] of Object.entries(value))
            visit(
              item,
              /^[A-Za-z_$][\w$]*$/.test(key) ?
                `${path}.${key}`
              : `${path}[${JSON.stringify(key)}]`,
              owner,
            )
        }
      }
      try {
        visit(JSON.parse(body), "$", "")
      } catch {
        leaves.push({ path: "$", role: "", text: body })
      }
      const parts = []
      for (const leaf of leaves) {
        const changed = [
          ...leaf.text.matchAll(new RegExp(REDACTION_TOKEN_SOURCE, "g")),
        ].some((match) => known.has(match[0]))
        if (changed) parts.push({ ...leaf, changed: true })
        else {
          if (!parts.length || parts.at(-1).changed)
            parts.push({ changed: false, leaves: [] })
          parts.at(-1).leaves.push(leaf)
        }
      }
      // A bounded wire prefix may end before the tool result. These contexts
      // are retained separately, and must never be presented as the full body.
      const visible = new Set(
        leaves.flatMap((leaf) =>
          [...leaf.text.matchAll(new RegExp(REDACTION_TOKEN_SOURCE, "g"))].map(
            (match) => match[0],
          ),
        ),
      )
      for (const excerpt of excerpts) {
        const missing = [
          ...excerpt.text.matchAll(new RegExp(REDACTION_TOKEN_SOURCE, "g")),
        ].some((match) => known.has(match[0]) && !visible.has(match[0]))
        if (missing)
          parts.push({ ...excerpt, role: "", changed: true, excerpt: true })
      }
      return parts
    },

    excerptSegments(text, whole = false, original = false) {
      const known = new Map(
        (this.detail?.mappings || []).map((mapping) => [
          mapping.placeholder,
          mapping,
        ]),
      )
      const hits = [
        ...text.matchAll(new RegExp(REDACTION_TOKEN_SOURCE, "g")),
      ].filter((match) => known.has(match[0]))
      const windows = []
      if (whole || text.length <= 600) windows.push([0, text.length])
      else
        for (const hit of hits) {
          const range = [
            Math.max(0, hit.index - 120),
            Math.min(text.length, hit.index + hit[0].length + 120),
          ]
          const last = windows.at(-1)
          if (last && range[0] <= last[1] + 20)
            last[1] = Math.max(last[1], range[1])
          else windows.push(range)
        }
      const segments = []
      let previous = 0
      for (const [start, end] of windows) {
        if (start > previous) segments.push({ text: "…", kind: "" })
        let at = start
        for (const hit of hits) {
          if (hit.index < start || hit.index >= end) continue
          if (hit.index > at)
            segments.push({ text: text.slice(at, hit.index), kind: "" })
          const mapping = known.get(hit[0])
          segments.push({
            placeholder: hit[0],
            text:
              (
                original
                && this.detailRevealed
                && typeof mapping?.value === "string"
              ) ?
                mapping.value + (mapping.truncated ? "…" : "")
              : hit[0],
            kind: mapping?.kind || "SECRET",
          })
          at = hit.index + hit[0].length
        }
        if (at < end) segments.push({ text: text.slice(at, end), kind: "" })
        previous = end
      }
      if (previous < text.length) segments.push({ text: "…", kind: "" })
      return segments
    },

    highlightPlaceholder(ph) {
      this.activePlaceholder = this.activePlaceholder === ph ? null : ph
    },

    kindTotal(kind) {
      return this.routeFilteredRecords.filter(
        (entry) => this.entryKindCount(entry, kind) > 0,
      ).length
    },

    redactionCounts(counts, group) {
      void this.lang
      const keys =
        group === "kind" ? REDACTION_KINDS : (
          ["builtin", "word", "homePrefix", "field", "known"]
        )
      return keys
        .map(
          (key) => `${I18n.t("system.redaction." + key)}: ${counts[key] || 0}`,
        )
        .join(" · ")
    },
  }
}
