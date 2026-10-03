/** Three-column routing stage, driven by live snapshots or a history clock. */
function tracesView() {
  return {
    ...ViewHelpers,
    traces: [],
    history: [],
    historyDate: "",
    historyError: "",
    historyLoading: false,
    keep: 60,
    selectedId: null,
    mode: "live",
    paused: false,
    connected: false,
    connecting: true,
    source: null,
    replaying: false,
    replayIndex: 0,
    replaySpeed: 2,
    replayElapsed: 0,
    replayDuration: 0,
    replayFrame: null,
    now: Date.now(),
    _ticker: null,
    _resize: null,
    _laneKey: null,
    _drawKey: null,
    _replayToken: 0,
    _historyToken: 0,
    _flightFrames: new Map(),
    _flights: new Map(),
    _flightPaths: new Map(),
    _flightRaf: null,
    _completedFlights: new Set(),

    init() {
      this.load()
      this.connect()
      this.$watch("paused", (p) => (p ? this.disconnect() : this.connect()))
      this.$watch("currentView", (view) => {
        if (view === "traces") this.refreshStage()
      })
      this._ticker = globalThis.setInterval(() => {
        if (this.traces.some((t) => t.inFlight)) this.now = Date.now()
      }, 250)
      this.$nextTick(() => {
        this._resize = new ResizeObserver(() => this.drawStage(true))
        if (this.$refs.lane) this._resize.observe(this.$refs.lane)
      })
    },

    destroy() {
      this.clearFlights()
      this.disconnect()
      this.stopReplay()
      globalThis.clearInterval(this._ticker)
      this._resize?.disconnect()
    },

    async load() {
      try {
        const data = await API.trace.recent(this.keep)
        this.keep = data.keep || this.keep
        // SSE may arrive before this snapshot. Keep the newest sequence.
        for (const frame of data.traces || []) this.push(frame)
      } catch (error) {
        console.warn("Trace snapshot unavailable", error)
      }
    },

    connect() {
      if (this.source || this.paused) return
      this.connecting = true
      this.source = API.trace.stream({
        onOpen: () => {
          this.connecting = false
          this.connected = true
        },
        onTrace: (frame) => this.push(frame),
        onError: () => {
          this.connected = false
          this.connecting = true
        },
      })
    },

    disconnect() {
      this.source?.close()
      this.source = null
      this.connected = false
      this.connecting = false
    },

    push(frame) {
      if (!frame?.requestId) return
      const index = this.traces.findIndex(
        (t) => t.requestId === frame.requestId,
      )
      const previous = this.traces[index]
      if (previous?.seq && frame.seq && previous.seq >= frame.seq) return
      if (index >= 0) this.traces.splice(index, 1, { ...previous, ...frame })
      else this.traces.push(frame)
      this.traces.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      if (this.traces.length > this.keep)
        this.traces.splice(0, this.traces.length - this.keep)
      if (this.mode !== "live") return
      const merged = this.traces.find((t) => t.requestId === frame.requestId)
      if (merged.inFlight || this._flightFrames.has(frame.requestId)) {
        this._flightFrames.set(frame.requestId, this.cloneFrame(merged))
      }
      // Bound backlog without interrupting any of the four visible flights.
      if (this._flightFrames.size > this.keep) {
        for (const id of this._flightFrames.keys()) {
          if (!this._flights.has(id)) this._flightFrames.delete(id)
          if (this._flightFrames.size <= this.keep) break
        }
      }
      // A late completion of an older concurrent request must not steal focus.
      const latest = this.traces.at(-1)
      this.selectedId = latest?.requestId || null
      this.refreshStage()
    },

    select(frame) {
      this.clearFlights()
      this.stopReplay()
      if (frame.inFlight) {
        this.mode = "live"
        this.selectedId = frame.requestId
        this.refreshStage()
        return
      }
      if (this.mode === "live") this.history = []
      this.mode = "history"
      if (!this.history.length)
        this.history = this.traces
          .filter((t) => !t.inFlight)
          .map((t) => this.cloneFrame(t))
      this.selectedId = frame.requestId
      this.refreshStage()
    },

    async showHistory() {
      this.clearFlights()
      this.stopReplay()
      this.mode = "history"
      this.historyLoading = true
      this.historyError = ""
      const token = ++this._historyToken
      try {
        const filters = { limit: 500 }
        if (this.historyDate) {
          const start = new Date(this.historyDate + "T00:00:00")
          const end = new Date(start)
          end.setDate(end.getDate() + 1)
          filters.timeFrom = start.getTime()
          filters.timeTo = end.getTime()
        }
        const data = await API.trace.history(filters)
        if (this.mode !== "history" || token !== this._historyToken) return
        const records = new Map()
        for (const f of data.traces || []) {
          if (f.requestId) records.set(f.requestId, { ...f, inFlight: false })
        }
        for (const f of this.traces.filter((t) => !t.inFlight)) {
          if (
            !this.historyDate
            || this.dateKey(f.timestamp) === this.historyDate
          )
            records.set(f.requestId, this.cloneFrame(f))
        }
        this.history = [...records.values()]
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-500)
        this.selectedId = this.history.at(-1)?.requestId || null
        this.refreshStage()
      } catch (error) {
        if (token === this._historyToken)
          this.historyError = String(error.message || error)
      } finally {
        if (token === this._historyToken) this.historyLoading = false
      }
    },

    dateKey(timestamp) {
      const d = new Date(timestamp)
      return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      ].join("-")
    },

    get visibleTraces() {
      return [
        ...(this.mode === "history" ? this.history : this.traces),
      ].reverse()
    },

    get selected() {
      if (this.replayFrame) return this.replayFrame
      const list = this.mode === "history" ? this.history : this.traces
      return list.find((t) => t.requestId === this.selectedId) || null
    },

    get laneNodes() {
      const f = this.selected
      if (!f) return []
      return [
        {
          key: "client",
          kind: "client",
          icon: "monitor",
          title: this.clientName(f),
          sub: f.modelRequested || f.model || this.apiLabel(f),
        },
        {
          key: "gateway",
          kind: "gateway",
          icon: "server",
          title: "Copilot API",
          sub: this.apiLabel(f),
        },
      ]
    },

    candidateKey(c) {
      return [c.connectionId || "", c.credentialId || "", c.model || ""].join(
        "::",
      )
    },

    get candidates() {
      const f = this.selected
      if (!f) return []
      const rows = (f.candidates || []).map((c) => ({ ...c }))
      // Include attempted paths even when the admission snapshot predates failover.
      for (const a of f.attempts || []) {
        if (!rows.some((c) => this.matchesTarget(c, a)))
          rows.push({
            ...a,
            model: a.upstreamModelId || f.modelUpstream,
            status: "available",
          })
      }
      if (f.connectionId && !rows.some((c) => this.matchesTarget(c, f))) {
        rows.push({
          connectionId: f.connectionId,
          connectionName: f.connectionName,
          credentialId: f.credentialId,
          credentialLabel: f.credentialLabel,
          provider: f.provider,
          model: f.modelUpstream || f.model,
          status: "chosen",
        })
      }
      // Keep seats used by packets still flying, even when a new request's
      // routing group differs. A new arrival changes the story, not the sky.
      for (const frame of this._flightFrames.values()) {
        for (const c of frame.candidates || []) {
          if (
            !rows.some((row) => this.candidateKey(row) === this.candidateKey(c))
          )
            rows.push({ ...c })
        }
        const target = this.frameTarget(frame)
        if (
          target
          && !rows.some(
            (c) => this.candidateKey(c) === this.candidateKey(target),
          )
        )
          rows.push(target)
      }
      for (const flight of this._flights.values()) {
        if (
          flight.target
          && !rows.some((c) => this.candidateKey(c) === flight.routeKey)
        )
          rows.push({ ...flight.target })
      }
      return rows
    },

    get showCandidatePlaceholder() {
      return Boolean(this.selected && this.candidates.length === 0)
    },

    frameTarget(frame) {
      if (!frame?.connectionId) return null
      return (
        frame.candidates?.find((c) => this.matchesTarget(c, frame)) || {
          connectionId: frame.connectionId,
          connectionName: frame.connectionName,
          credentialId: frame.credentialId,
          credentialLabel: frame.credentialLabel,
          model: frame.modelUpstream || frame.model,
          provider: frame.provider,
          status: "chosen",
        }
      )
    },

    matchesTarget(c, target) {
      return (
        c.connectionId === target.connectionId
        && (!target.credentialId || c.credentialId === target.credentialId)
        && (!target.modelUpstream
          || !c.model
          || c.model === target.modelUpstream)
      )
    },

    candidateState(c) {
      for (const frame of this._flightFrames.values()) {
        if (this.matchesTarget(c, frame) && frame.inFlight) {
          return frame.ttftMs !== undefined ? "streaming" : "waiting"
        }
      }
      const f = this.selected
      const active =
        f?.connectionId ? this.matchesTarget(c, f) : c.status === "chosen"
      if (active) {
        if (f.inFlight) return f.ttftMs !== undefined ? "streaming" : "waiting"
        if (f.outcome === "failed" || f.statusCode >= 400) return "failed"
        if (f.outcome === "cancelled") return "cancelled"
        if (f.outcome === "incomplete") return "incomplete"
        return "answered"
      }
      if (
        f?.attempts?.some(
          (a) => this.matchesTarget(c, a) && a.result === "failed",
        )
      )
        return "failed"
      if (
        ["quota", "auth", "disabled", "cooldown", "unknown"].includes(c.status)
      )
        return "resting"
      return "standby"
    },

    candLabel(c) {
      const state = this.candidateState(c)
      if (state === "answered") return this.t("trace.cand.selectedPath")
      if (state === "incomplete") return this.t("trace.incomplete")
      if (state !== "resting") return this.t("trace.state." + state)
      return this.t("trace.cand." + (c.restReason || c.status))
    },

    get stageStatus() {
      const f = this.selected
      if (!f) return this.t("trace.empty")
      if (f.inFlight) {
        if (!f.connectionId) return this.t("trace.stageRouting")
        return this.t(
          f.ttftMs !== undefined ?
            "trace.state.streaming"
          : "trace.state.waiting",
        )
      }
      if (f.outcome === "incomplete") return this.t("trace.incomplete")
      return this.t(
        "trace.state."
          + (f.outcome === "failed" || f.statusCode >= 400 ? "failed"
          : f.outcome === "cancelled" ? "cancelled"
          : "answered"),
      )
    },

    refreshStage() {
      this.$nextTick(() => {
        const key = this.laneNodes.map((n) => n.key + n.title).join("|")
        if (key !== this._laneKey) {
          this._laneKey = key
          lucide.createIcons()
        }
        this.drawStage()
      })
    },

    /**
     * Evidence line under a candidate: quota pressure, when it renews or
     * the rest lifts, and how much it served lately.
     */
    candQuotaPercent(c) {
      if (
        typeof c.quotaUsedPct !== "number"
        || !Number.isFinite(c.quotaUsedPct)
      )
        return undefined
      return QuotaDisplay.displayPercent(
        100 - c.quotaUsedPct,
        this.quotaDisplayMode,
      )
    },

    candEvidence(c) {
      const parts = []
      if (c.quotaUsedPct !== undefined && c.quotaUsedPct !== null) {
        const percent = this.candQuotaPercent(c)
        if (percent !== undefined) {
          parts.push(
            this.t(
              this.quotaDisplayMode === "used" ?
                "trace.ev.quotaUsed"
              : "trace.ev.quotaRemaining",
              { n: Math.round(percent) },
            ),
          )
        }
      }
      if (c.restUntilMs && c.restUntilMs > this.now) {
        parts.push(
          this.t("trace.ev.rest", { t: this.fmtDur(c.restUntilMs - this.now) }),
        )
      } else if (c.renewAtMs && c.renewAtMs > this.now) {
        parts.push(
          this.t("trace.ev.renew", { t: this.fmtDur(c.renewAtMs - this.now) }),
        )
      }
      if (c.servedTokens) {
        parts.push(this.t("trace.ev.served", { n: c.servedTokens }))
      }
      return parts.join(" · ")
    },

    // ---------- derived: stats ----------

    get stats() {
      const requests = this.traces.length
      const failover = this.traces.filter(
        (t) => (t.failoverCount || 0) > 0,
      ).length
      const errors = this.traces.filter((t) => t.outcome === "failed").length
      const inFlight = this.traces.filter((t) => t.inFlight).length
      return { requests, failover, errors, inFlight }
    },

    // ---------- derived: timeline ----------

    get timeline() {
      const f = this.selected
      if (!f || !f.latencyMs || f.latencyMs <= 0) return null
      const total = f.latencyMs
      const ttft = f.ttftMs && f.ttftMs > 0 ? Math.min(f.ttftMs, total) : null
      const segs = []
      if (ttft) {
        segs.push({
          cls: "upstream",
          label: this.t("trace.stageUpstream"),
          pct: (ttft / total) * 100,
        })
        segs.push({
          cls: "generate",
          label: this.t("trace.stageGenerate"),
          pct: ((total - ttft) / total) * 100,
        })
      } else {
        segs.push({
          cls: "upstream",
          label: this.t("trace.stageUpstream"),
          pct: 100,
        })
      }
      // Lay them out left-to-right.
      let acc = 0
      for (const s of segs) {
        s.left = acc
        acc += s.pct
      }
      return {
        total,
        ttft,
        segs,
        markerPct: ttft ? (ttft / total) * 100 : null,
      }
    },

    // ---------- derived: explanations ----------

    get explanations() {
      const f = this.selected
      if (!f) return []
      if (f.inFlight) {
        return [
          {
            cls: "pending",
            text: [this.clientName(f), f.connectionName, this.stageStatus]
              .filter(Boolean)
              .join(" · "),
          },
        ]
      }
      const lines = []
      if (this.isGroup(f)) {
        lines.push({
          cls: this.outcomeClass(f),
          text: this.t("trace.groupRouteSummary", {
            client: this.clientName(f),
            group: this.groupName(f),
            count: this.groupMembersCount(f),
          }),
        })
        lines.push({
          cls: "ok",
          text: this.t("trace.groupDecisionSummary", {
            strategy: this.groupStrategyLabel(f),
            model: this.groupWinnerModel(f),
            target: f.finalTarget || f.connectionName || "—",
          }),
        })
      } else {
        lines.push({
          cls: this.outcomeClass(f),
          text: this.t("trace.routeSummary", {
            provider: f.provider || "—",
            target: f.finalTarget || f.connectionName || "—",
            model: f.model || f.modelUpstream || "—",
          }),
        })
      }
      if ((f.failoverCount || 0) > 0) {
        lines.push({
          cls: "fail",
          text: this.t("trace.failoverN", {
            n: f.failoverCount,
            target: f.finalTarget || f.connectionName || "—",
          }),
        })
      } else {
        lines.push({ cls: "ok", text: this.t("trace.failoverNone") })
      }
      if (f.latencyMs) {
        lines.push({
          cls: "ok",
          text: this.t("trace.timingSummary", {
            ttft: f.ttftMs ? this.took(f.ttftMs) : "—",
            total: this.took(f.latencyMs),
          }),
        })
      }
      return lines
    },

    // ---------- curved routing wires and directional packets ----------

    drawStage(force = false) {
      const lane = this.$refs.lane
      const svg = this.$refs.wires
      if (!lane || !svg || !lane.clientWidth) return
      const nodes = [...lane.querySelectorAll(".tr-node")]
      const rows = [...lane.querySelectorAll(".tr-cand")]
      const key = [
        this.selected?.requestId,
        this.stageStatus,
        ...[...this._flightFrames.values()].map(
          (f) => f.requestId + f.inFlight + f.connectionId,
        ),
        ...this.candidates.map(
          (c) => this.candidateKey(c) + this.candidateState(c),
        ),
      ].join("|")
      if (!force && key === this._drawKey) return
      this._drawKey = key
      svg.replaceChildren()
      this._flightPaths.clear()
      if (nodes.length < 2) return
      const rect = lane.getBoundingClientRect()
      svg.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height)
      const point = (el, side) => {
        const r = el.getBoundingClientRect()
        return {
          x: (side === "left" ? r.left : r.right) - rect.left,
          y: r.top + r.height / 2 - rect.top,
        }
      }
      const curve = (a, b) => {
        const mid = (a.x + b.x) / 2
        return (
          "M "
          + a.x
          + " "
          + a.y
          + " C "
          + mid
          + " "
          + a.y
          + ", "
          + mid
          + " "
          + b.y
          + ", "
          + b.x
          + " "
          + b.y
        )
      }
      const inbound = curve(point(nodes[0], "right"), point(nodes[1], "left"))
      this.svgElement(svg, "path", { d: inbound, class: "tr-wire inbound" })
      const reduced = globalThis.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches
      rows.forEach((row, i) => {
        const c = this.candidates[i]
        if (!c) return
        const state = this.candidateState(c)
        const d = curve(point(nodes[1], "right"), point(row, "left"))
        this.svgElement(svg, "path", { d, class: "tr-wire " + state })
        // A continuous path crosses the gateway instead of teleporting
        // between two disconnected SVG subpaths.
        const continuous = inbound + " " + d.replace(/^M /, "L ")
        const path = this.svgElement(svg, "path", {
          d: continuous,
          class: "tr-flight-path",
        })
        this._flightPaths.set(this.candidateKey(c), path)
        this._flightPaths.set(
          "branch:" + this.candidateKey(c),
          this.svgElement(svg, "path", { d, class: "tr-flight-path" }),
        )
      })
      this._flightPaths.set(
        "gateway",
        this.svgElement(svg, "path", { d: inbound, class: "tr-flight-path" }),
      )
      const sky = this.$refs.flights
      if (!sky) return
      sky.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height)
      if (reduced) {
        this.clearFlights()
        return
      }
      if (
        this.replaying
        && this.selected
        && !this._completedFlights.has(this.selected.requestId)
      ) {
        this._flightFrames.set(
          this.selected.requestId,
          this.cloneFrame(this.selected),
        )
      }
      this.startFlights()
    },

    svgElement(parent, tag, attributes) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag)
      for (const [name, value] of Object.entries(attributes))
        el.setAttribute(name, value)
      parent.append(el)
      return el
    },

    // Each request owns a packet and a clock. Redrawing wires never removes
    // another request's packet; at most four fly at once.
    startFlights() {
      const sky = this.$refs.flights
      if (!sky) return
      for (const [id, frame] of this._flightFrames) {
        if (this._flights.has(id)) continue
        if (this._flights.size >= 4) break
        const target = this.frameTarget(frame)
        const routeKey = target ? this.candidateKey(target) : "gateway"
        if (!this._flightPaths.has(routeKey)) continue
        const packet = this.svgElement(sky, "circle", {
          r: "4",
          class: "tr-flow-packet",
          "data-request-id": id,
        })
        // Stable per-request color lets overlapping requests remain distinct.
        const palette = [
          "var(--apple-blue)",
          "var(--apple-orange)",
          "var(--apple-purple)",
          "var(--apple-green)",
        ]
        const slot = [...this._flights.values()].map((f) => f.slot)
        const colorSlot = [0, 1, 2, 3].find((n) => !slot.includes(n))
        packet.style.setProperty("--packet-color", palette[colorSlot])
        this._flights.set(id, {
          packet,
          slot: colorSlot,
          phase: "out",
          started: performance.now(),
          routeKey,
          target,
        })
      }
      if (this._flights.size && this._flightRaf === null) {
        this._flightRaf = globalThis.requestAnimationFrame((time) =>
          this.tickFlights(time),
        )
      }
    },

    advanceFlight(flight, frame, time) {
      const target = this.frameTarget(frame)
      const targetKey = target ? this.candidateKey(target) : "gateway"
      const elapsed = time - flight.started
      if (flight.phase === "out" && elapsed < 900) return false
      if (flight.phase === "out") flight.phase = "held"
      if (flight.phase === "held") {
        if (targetKey !== flight.routeKey) {
          flight.phase = flight.routeKey === "gateway" ? "out" : "retry"
          flight.started = time
          if (flight.routeKey === "gateway") flight.routeKey = targetKey
          if (flight.phase === "out") flight.branchOnly = true
          if (flight.phase === "out") flight.target = target
        } else if (!frame.inFlight) {
          flight.phase = "back"
          flight.started = time
        }
      } else if (flight.phase === "retry" && elapsed >= 620) {
        flight.routeKey = targetKey
        flight.target = target
        flight.branchOnly = true
        flight.phase = "out"
        flight.started = time
      } else if (flight.phase === "back" && elapsed >= 1600) return true
      return false
    },

    tickFlights(time) {
      this._flightRaf = null
      let removed = false
      for (const [id, flight] of this._flights) {
        const frame = this._flightFrames.get(id)
        if (!frame || this.advanceFlight(flight, frame, time)) {
          flight.packet.remove()
          this._flights.delete(id)
          this._flightFrames.delete(id)
          if (this.replaying) this._completedFlights.add(id)
          removed = true
          continue
        }
        this.poseFlight(flight, frame, time)
      }
      if (removed) this.refreshStage()
      this.startFlights()
    },

    poseFlight(flight, frame, time) {
      const retry = flight.phase === "retry"
      const path = this._flightPaths.get(
        (retry || (flight.phase === "out" && flight.branchOnly) ?
          "branch:"
        : "") + flight.routeKey,
      )
      if (!path) return
      const returning = retry || flight.phase === "back"
      const duration =
        retry ? 620
        : returning ? 1600
        : 900
      const fraction =
        flight.phase === "held" ?
          1
        : Math.min(1, Math.max(0, (time - flight.started) / duration))
      const eased = (1 - Math.cos(Math.PI * fraction)) / 2
      const point = path.getPointAtLength(
        path.getTotalLength() * (returning ? 1 - eased : eased),
      )
      flight.packet.setAttribute("cx", point.x)
      flight.packet.setAttribute("cy", point.y)
      flight.packet.setAttribute(
        "class",
        "tr-flow-packet"
          + (returning ? " back" : "")
          + (flight.phase === "held" ? " held" : "")
          + ((
            returning
            && (retry || frame.outcome === "failed" || frame.statusCode >= 400)
          ) ?
            " error"
          : ""),
      )
    },

    clearFlights() {
      if (this._flightRaf !== null)
        globalThis.cancelAnimationFrame(this._flightRaf)
      this._flightRaf = null
      for (const flight of this._flights.values()) flight.packet.remove()
      this._flights.clear()
      this._flightFrames.clear()
      this._completedFlights.clear()
      this._drawKey = null
    },

    stopReplay() {
      this.clearFlights()
      this._replayToken++
      this.replaying = false
      this.replayFrame = null
      this.replayIndex = 0
    },

    async replayOne(frame = this.selected) {
      if (!frame || frame.inFlight || this.replaying || this.historyLoading)
        return
      return this.playFrames([this.cloneFrame(frame)])
    },

    get replayableFrames() {
      return (this.mode === "history" ? this.history : this.traces).filter(
        (frame) => !frame.inFlight,
      )
    },

    async replayAll() {
      if (this.replaying || this.historyLoading) return
      return this.playFrames(
        this.replayableFrames.map((frame) => this.cloneFrame(frame)),
      )
    },

    async playFrames(frames) {
      this.stopReplay()
      if (!frames.length) return
      if (this.mode !== "history") {
        this.history = this.replayableFrames.map((frame) =>
          this.cloneFrame(frame),
        )
      }
      this.mode = "history"
      this.replaying = true
      const token = this._replayToken
      for (let i = 0; i < frames.length; i++) {
        if (token !== this._replayToken) return
        const frame = frames[i]
        this.selectedId = frame.requestId
        this.replayIndex = i + 1
        this.replayDuration = Math.max(1, frame.latencyMs || 1)
        this.replayElapsed = 0
        let last = performance.now()
        while (
          this.replayElapsed < this.replayDuration
          && token === this._replayToken
        ) {
          const now = performance.now()
          this.replayElapsed = Math.min(
            this.replayDuration,
            this.replayElapsed + (now - last) * this.replaySpeed,
          )
          last = now
          this.replayFrame = this.replayAt(frame, this.replayElapsed)
          this.refreshStage()
          await new Promise((resolve) => globalThis.setTimeout(resolve, 40))
        }
        if (token !== this._replayToken) return
        this.replayFrame = frame
        this.refreshStage()
        await this.$nextTick?.()
        // The visual trip can outlast a short response or an accelerated replay.
        while (
          this._flightFrames.has(frame.requestId)
          && token === this._replayToken
        ) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 40))
        }
      }
      if (token === this._replayToken) {
        this.replaying = false
        this.replayFrame = null
        this.refreshStage()
      }
    },

    replayAt(frame, elapsed) {
      const done = elapsed >= Math.max(1, frame.latencyMs || 1)
      const ghost = { ...frame, inFlight: !done, attempts: [] }
      if (!done) {
        ghost.serviceTierUpstream = undefined
        ghost.serviceTierResponse = undefined
        ghost.outcome = undefined
        ghost.statusCode = undefined
        ghost.error = undefined
        ghost.totalTokens = undefined
        ghost.completionTokens = undefined
        ghost.ttftMs =
          frame.ttftMs !== undefined && elapsed >= frame.ttftMs ?
            frame.ttftMs
          : undefined
        let spent = 0
        const attempts = frame.attempts || []
        for (const a of attempts) {
          const end = spent + (a.latencyMs || 0)
          if (a.result === "failed" && elapsed < end) {
            Object.assign(ghost, {
              connectionId: a.connectionId,
              credentialId: a.credentialId,
              connectionName: a.connectionName,
              provider: a.provider,
              modelUpstream: undefined,
              serviceTierUpstream: a.serviceTierUpstream,
              serviceTierResponse: a.serviceTierResponse,
            })
            return ghost
          }
          ghost.attempts.push(a)
          ghost.serviceTierUpstream = a.serviceTierUpstream
          ghost.serviceTierResponse = a.serviceTierResponse
          spent = end
        }
      } else ghost.attempts = frame.attempts
      return ghost
    },

    backToLive() {
      this.stopReplay()
      this._historyToken++
      this.historyLoading = false
      this.mode = "live"
      this.selectedId = this.traces.at(-1)?.requestId || null
      this.refreshStage()
    },

    cloneFrame(frame) {
      // Alpine's reactive proxies cannot be passed to structuredClone.
      return JSON.parse(JSON.stringify(frame))
    },

    // ---------- formatting ----------

    clientName(f) {
      return (
        f.initiator
        || f.username
        || f.userAgent?.split("/")[0]
        || this.t("trace.unknownClient")
      )
    },

    apiLabel(f) {
      const map = {
        chat: "Chat Completions",
        messages: "Messages",
        responses: "Responses",
        gemini: "Gemini",
        embeddings: "Embeddings",
      }
      return map[f.apiKind] || f.apiKind || f.endpoint || ""
    },

    shorten(v) {
      if (!v) return ""
      const s = String(v)
      return s.length > 32 ? `${s.slice(0, 14)}…${s.slice(-12)}` : s
    },

    fmtTime(ts) {
      if (!ts) return "—"
      const d = new Date(ts)
      return d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    },

    took(ms) {
      if (ms === undefined || ms === null) return "—"
      if (ms < 1000) return `${Math.round(ms)} ms`
      return `${(ms / 1000).toFixed(1)} s`
    },

    /** Compact countdown: 42s / 18m / 7h / 4d. */
    fmtDur(ms) {
      const s = Math.ceil(ms / 1000)
      if (s < 60) return `${s}s`
      const m = Math.ceil(s / 60)
      if (m < 60) return `${m}m`
      const h = Math.ceil(m / 60)
      if (h < 48) return `${h}h`
      return `${Math.ceil(h / 24)}d`
    },

    outcomeClass(f) {
      if (!f) return "ok"
      if (f.outcome === "failed") return "fail"
      if (f.outcome === "cancelled") return "warn"
      return "ok"
    },

    rowDotClass(f) {
      if (!f) return "ok"
      if (f.inFlight) return "inflight"
      if (f.outcome === "failed") return "fail"
      if (f.outcome === "cancelled") return "cancel"
      if (f.outcome === "incomplete") return "warn"
      return "ok"
    },

    /** Right-hand cell: a live elapsed counter while running, timings once done. */
    rowTiming(f) {
      if (f.inFlight) {
        const started = f.timestamp ?? this.now
        return this.t("trace.inflight") + " " + this.took(this.now - started)
      }
      let s = this.took(f.latencyMs)
      if (f.ttftMs)
        s += ` · ${this.t("trace.firstToken")} ${this.took(f.ttftMs)}`
      return s
    },

    rowRoute(f) {
      const conn = f.connectionName || f.provider || "—"
      const cred = f.credentialLabel ? ` · ${f.credentialLabel}` : ""
      return `${conn}${cred}`
    },

    routeLabel(f) {
      if (!f) return ""
      return `${this.apiLabel(f)} · ${f.model || f.modelUpstream || "—"}`
    },

    serviceTierInfo(frame) {
      let source = frame
      const lastAttempt = frame?.attempts?.at(-1)
      if (
        !frame?.inFlight
        && !frame?.serviceTierUpstream
        && !frame?.serviceTierResponse
        && lastAttempt
        && ["connectionId", "credentialId", "provider"].every(
          (key) => !frame[key] || frame[key] === lastAttempt[key],
        )
      ) {
        source = lastAttempt
      }
      return {
        requested: frame?.serviceTierRequested,
        routed: frame?.serviceTierRouted,
        sent: source?.serviceTierUpstream,
        reported: source?.serviceTierResponse,
      }
    },

    serviceTierLabel(tier) {
      if (!tier) return this.t("trace.tierUnknown")
      const labels = {
        priority: "trace.tierFast",
        fast: "trace.tierFast",
        default: "trace.tierNormal",
        auto: "trace.tierAuto",
        flex: "trace.tierFlex",
        scale: "trace.tierScale",
      }
      return labels[tier] ? this.t(labels[tier]) : tier
    },

    isFastServiceTier(tier) {
      return tier === "priority" || tier === "fast"
    },

    serviceTiersMatch(sent, reported) {
      return (
        sent === reported
        || (this.isFastServiceTier(sent) && this.isFastServiceTier(reported))
      )
    },

    serviceTierStatus(frame) {
      const { requested, routed, sent, reported } = this.serviceTierInfo(frame)
      const wantsFast =
        this.isFastServiceTier(requested) || this.isFastServiceTier(routed)
      if (reported && (!sent || this.serviceTiersMatch(sent, reported))) {
        const confirmed =
          this.isFastServiceTier(reported) ?
            this.t("trace.fastConfirmed")
          : this.t("trace.tierConfirmedMode", {
              mode: this.serviceTierLabel(reported),
            })
        if (wantsFast && sent && !this.isFastServiceTier(sent)) {
          return this.t("trace.fastNotSent") + " → " + confirmed
        }
        return confirmed
      }
      if (!sent) {
        if (!wantsFast) return ""
        return this.t(
          frame?.inFlight ? "trace.fastPendingSend" : "trace.fastNoSendRecord",
        )
      }
      const request =
        this.isFastServiceTier(sent) ?
          this.t("trace.fastRequested")
        : this.t("trace.tierRequestMode", {
            mode: this.serviceTierLabel(sent),
          })
      if (reported) {
        return (
          request
          + " → "
          + this.t("trace.tierReportedMode", {
            mode: this.serviceTierLabel(reported),
          })
        )
      }
      if (wantsFast && !this.isFastServiceTier(sent)) {
        return this.t("trace.fastNotSent") + " → " + request
      }
      if (!this.isFastServiceTier(sent)) return request
      return (
        request
        + " · "
        + this.t(
          frame?.inFlight ? "trace.tierPending" : "trace.tierUnconfirmed",
        )
      )
    },

    serviceTierClass(frame) {
      const { requested, routed, sent, reported } = this.serviceTierInfo(frame)
      if (reported && sent && !this.serviceTiersMatch(sent, reported))
        return "changed"
      if (
        (this.isFastServiceTier(requested) || this.isFastServiceTier(routed))
        && sent
        && !this.isFastServiceTier(sent)
      )
        return "changed"
      if (this.isFastServiceTier(reported)) return "confirmed"
      if (this.isFastServiceTier(sent)) return "pending"
      return ""
    },

    serviceTierHint(frame) {
      const { sent, reported } = this.serviceTierInfo(frame)
      if (sent && reported && !this.serviceTiersMatch(sent, reported))
        return this.t("trace.tierMismatchHint")
      if (reported) return ""
      if (!sent) return this.t("trace.tierNoSendHint")
      return this.t(
        frame?.inFlight ? "trace.tierPendingHint" : "trace.tierMissingHint",
      )
    },

    serviceTierDetails(frame) {
      const tiers = this.serviceTierInfo(frame)
      return [
        ["requested", "trace.tierRequested"],
        ["routed", "trace.tierRouted"],
        ["sent", "trace.tierSent"],
        ["reported", "trace.tierReported"],
      ]
        .filter(([field]) => tiers[field])
        .map(([field, label]) => ({
          label: this.t(label),
          value: `${this.serviceTierLabel(tiers[field])} (${tiers[field]})`,
        }))
    },

    serviceTierSummary(frame) {
      return this.serviceTierDetails(frame)
        .map(({ label, value }) => `${label}: ${value}`)
        .join(" · ")
    },

    isGroup(f) {
      if (!f) return false
      return Boolean(
        f.routingGroupId
          || f.routingGroupName
          || (typeof f.modelRequested === "string"
            && f.modelRequested.startsWith("group/")),
      )
    },

    groupName(f) {
      if (!f) return ""
      return (
        f.routingGroupName
        || f.routingGroupId
        || (typeof f.modelRequested === "string" ?
          f.modelRequested.replace(/^group\//, "")
        : "")
      )
    },

    groupMembersCount(f) {
      if (f?.routingGroupMembers?.length) return f.routingGroupMembers.length
      if (this.candidates?.length) return this.candidates.length
      return 0
    },

    groupStrategyLabel(f) {
      const mode = f?.routingStrategy || "order"
      return this.t(`trace.groupStrategy.${mode}`) || mode
    },

    groupWinnerModel(f) {
      if (!f) return ""
      return f.routingGroupSelectedMember || f.modelUpstream || f.model || ""
    },

    rowModelDisplay(f) {
      if (!f) return "-"
      if (this.isGroup(f)) {
        const gName = this.groupName(f)
        const winner = this.groupWinnerModel(f)
        return winner ? `${gName} → ${winner}` : gName
      }
      return (
        f.model
        || f.modelUpstream
        || f.modelRequested
        || (f.path ? [f.method, f.path].filter(Boolean).join(" ") : "-")
      )
    },
  }
}
