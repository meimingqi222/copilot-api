/**
 * Requests / 请求追踪 view.
 *
 * A live trace of the gateway: each finalized request replays its journey as a
 * packet crossing client -> gateway -> connection -> credential -> upstream,
 * with a warm packet coming back (or hopping to the next candidate on
 * failover). Data comes from /admin/api/trace (recent + SSE stream); every row
 * and number is what the request log already recorded — nothing is recomputed
 * here.
 *
 * Motion is used for the packet travel when the Motion global is present
 * (CDN, pinned); otherwise the Web Animations API drives the same paths so the
 * view never depends on the network for its core interaction.
 */
function tracesView() {
  return {
    ...ViewHelpers,
    traces: [],
    keep: 60,
    selectedId: null,
    paused: false,
    connected: false,
    connecting: true,
    source: null,
    replaying: false,
    replayIndex: 0,
    now: Date.now(),
    _animToken: 0,
    _timers: [],
    _ticker: null,
    _laneKey: null,

    init() {
      this.load()
      this.connect()
      this.$watch("paused", (p) => (p ? this.disconnect() : this.connect()))
      // Tick only while something is in flight, so an in-flight row's elapsed
      // counter looks live without re-rendering the idle view every second.
      this._ticker = globalThis.setInterval(() => {
        if (this.traces.some((t) => t.inFlight)) this.now = Date.now()
      }, 500)
      this.$nextTick(() => this.renderIconsIfNeeded())
    },

    async load() {
      try {
        const data = await API.trace.recent(this.keep)
        this.keep = data.keep || this.keep
        this.traces = (data.traces || []).slice()
        if (!this.selectedId && this.traces.length) {
          this.select(this.traces[this.traces.length - 1])
        }
      } catch {
        // The live stream will repopulate; a failed snapshot is not fatal.
      }
      this.$nextTick(() => this.renderIconsIfNeeded())
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
          // EventSource auto-reconnects; surface the gap instead of erroring.
          this.connected = false
          this.connecting = true
        },
      })
    },

    disconnect() {
      if (this.source) {
        this.source.close()
        this.source = null
      }
      this.connected = false
      this.connecting = false
    },

    push(frame) {
      if (!frame || !frame.requestId) return
      const existing = this.traces.findIndex(
        (t) => t.requestId === frame.requestId,
      )
      if (existing >= 0) this.traces.splice(existing, 1, frame)
      else this.traces.push(frame)
      if (this.traces.length > this.keep) {
        this.traces.splice(0, this.traces.length - this.keep)
      }
      // A fresh arrival takes the stage unless the user is inspecting another.
      if (!this.selectedId || this.selectedId === frame.requestId) {
        this.select(frame)
      }
    },

    select(frame) {
      this.selectedId = frame.requestId
      this.$nextTick(() => {
        this.renderIconsIfNeeded()
        // In-flight: hold a waiting packet at the frontier node. Once the
        // final frame lands (same requestId), replay the whole journey.
        if (frame.inFlight) this.playInFlight(frame)
        else this.playJourney(frame)
      })
    },

    /**
     * lucide.createIcons() walks the whole document and swaps every
     * `[data-lucide]` node for an SVG — far too heavy to run on each selection
     * or arrival. The lane's nodes only change when their identity changes, so
     * only re-render when that key does.
     */
    renderIconsIfNeeded() {
      const key = this.laneNodes
        .map((n) => `${n.key}:${n.kind}:${n.title}`)
        .join("|")
      if (key === this._laneKey) return
      this._laneKey = key
      lucide.createIcons()
    },

    // ---------- derived: the lane ----------

    get visibleTraces() {
      // Newest first, matching the list.
      return [...this.traces].reverse()
    },

    get selected() {
      return this.traces.find((t) => t.requestId === this.selectedId) || null
    },

    get laneNodes() {
      const f = this.selected
      const nodes = []
      if (!f) return nodes
      nodes.push({
        key: "client",
        kind: "client",
        icon: "monitor",
        title: this.clientName(f),
        sub: f.clientIp || "",
      })
      nodes.push({
        key: "gateway",
        kind: "gateway",
        icon: "server",
        title: "Copilot API",
        sub: this.apiLabel(f),
      })
      // Connection + credential are one route node: the credential is the
      // account the connection routes over, so splitting them only added a
      // second long (often UUID) card that pushed the lane off-screen.
      if (f.connectionName || f.provider || f.connectionId) {
        const hasLabel = Boolean(f.credentialLabel)
        nodes.push({
          key: "route",
          kind: "connection",
          icon: hasLabel ? "key" : "plug",
          title:
            (hasLabel ?
              f.credentialLabel
            : f.connectionName || f.provider || f.connectionId) || "",
          sub: (hasLabel ?
            [f.connectionName, f.provider]
          : [f.provider, f.protocol]
          )
            .filter(Boolean)
            .join(" · "),
        })
      }
      nodes.push({
        key: "upstream",
        kind: "upstream",
        icon: "cpu",
        title: f.modelUpstream || f.model || this.t("trace.noModel"),
        sub: f.upstreamBaseUrl ? this.shorten(f.upstreamBaseUrl) : "",
      })
      return nodes
    },

    get laneItems() {
      const items = []
      this.laneNodes.forEach((node, i) => {
        if (i > 0) items.push({ key: `rail-${i}`, rail: true })
        items.push({ ...node, rail: false })
      })
      return items
    },

    // ---------- derived: candidate paths ----------

    get candidates() {
      return this.selected?.candidates ?? []
    },

    candLabel(c) {
      const status = c?.status
      const reason = c?.restReason
      // A resting candidate reads better by its semantic reason (credit /
      // rate / verify) than by the generic status bucket.
      if (
        reason
        && status !== "chosen"
        && status !== "available"
        && status !== "translated"
        && status !== "wildcard"
      ) {
        return this.t(`trace.cand.${reason}`)
      }
      return this.t(`trace.cand.${status}`)
    },

    candDot(c) {
      const status = c?.status
      if (status === "chosen" || status === "available") return "ok"
      if (status === "translated" || status === "wildcard") return "warn"
      if (
        status === "quota"
        || status === "auth"
        || status === "disabled"
        || c?.restReason === "credit"
        || c?.restReason === "verify"
        || c?.restReason === "rate"
      ) {
        return "fail"
      }
      return "cancel"
    },

    candSub(c) {
      const model = c.model || this.selected?.model || "—"
      return `${c.endpoint || ""} · ${model}`.replace(/^ · /, "")
    },

    /**
     * Evidence line under a candidate: quota pressure, when it renews or
     * the rest lifts, and how much it served lately.
     */
    candEvidence(c) {
      const parts = []
      if (c.quotaUsedPct !== undefined && c.quotaUsedPct !== null) {
        parts.push(this.t("trace.ev.quota", { n: c.quotaUsedPct }))
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
      const lines = []
      lines.push({
        cls: this.outcomeClass(f),
        text: this.t("trace.routeSummary", {
          provider: f.provider || "—",
          target: f.finalTarget || f.connectionName || "—",
          model: f.model || f.modelUpstream || "—",
        }),
      })
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

    // ---------- animation ----------

    /**
     * Index of the node that answers the request: the credential when the lane
     * has one, otherwise the upstream node. Shared by the in-flight and finished
     * renderers so both put the packet on the same node.
     */
    answerIndexOf(frame, count) {
      const isNative = !(
        frame.connectionName
        || frame.provider
        || frame.connectionId
      )
      return Math.max(1, isNative ? count - 1 : count - 2)
    },

    centerX(el, laneRect) {
      const r = el.getBoundingClientRect()
      return r.left + r.width / 2 - laneRect.left
    },

    /**
     * In-flight: park a softly breathing packet on the frontier node so the
     * request is visible while it runs — routing may add nodes (connection,
     * credential) as they resolve, and each arrival re-parks the packet.
     */
    async playInFlight(frame) {
      const lane = this.$refs.lane
      const layer = this.$refs.packets
      if (!lane || !layer) return
      await this.$nextTick()
      ++this._animToken
      this.clearTimers()
      layer.replaceChildren()
      const nodes = [...lane.querySelectorAll(".tr-node")]
      if (nodes.length < 2) return
      const laneRect = lane.getBoundingClientRect()
      const frontier = nodes[this.answerIndexOf(frame, nodes.length)]
      frontier.classList.add("active")
      this.spawnPacket(layer, this.centerX(frontier, laneRect), "req pending")
    },

    /**
     * Replay one request as a packet crossing the lane.
     *
     * Each leg is a SINGLE keyframe animation across every node it passes
     * (Motion/WAAPI interpolate between the stop points), not one animation per
     * hop — per-hop create/await cycles were what made it feel stuttery. The
     * packet element is created once per leg and composited with transforms
     * only, so it rides the compositor thread.
     */
    async playJourney(frame) {
      const lane = this.$refs.lane
      const layer = this.$refs.packets
      if (!lane || !layer || !frame) return
      await this.$nextTick()
      const token = ++this._animToken
      this.clearTimers()
      // Drop any packet left mid-flight by a superseded replay.
      layer.replaceChildren()
      const nodes = [...lane.querySelectorAll(".tr-node")]
      if (nodes.length < 2) return
      const laneRect = lane.getBoundingClientRect()
      const centers = nodes.map((n) => this.centerX(n, laneRect))
      const answerIndex = this.answerIndexOf(frame, nodes.length)
      const failed = frame.outcome === "failed"
      for (const n of nodes) n.classList.remove("active", "hit-ok", "hit-fail")

      const SEG = 0.34 // seconds between adjacent nodes
      const forwardStops = centers
        .slice(0, answerIndex + 1)
        .map((c) => c - centers[0])
      const forwardDuration = SEG * answerIndex

      // Node highlights fire as the packet passes, scheduled off the same
      // segment length so they stay in step with the glide.
      for (let i = 1; i <= answerIndex; i++) {
        const isAnswer = i === answerIndex
        const at = SEG * 1000 * i - SEG * 220
        this._timers.push(
          globalThis.setTimeout(
            () => {
              if (this._animToken !== token) return
              nodes[i].classList.remove("active")
              nodes[i].classList.add(
                isAnswer ?
                  failed ? "hit-fail"
                  : "hit-ok"
                : "active",
              )
            },
            Math.max(0, at),
          ),
        )
      }

      const forward = this.spawnPacket(layer, centers[0], "req")
      await this.animateX(forward, forwardStops, forwardDuration)
      if (this._animToken !== token) return forward.remove()
      if (!failed) this.spawnSpark(layer, centers[answerIndex])

      // Back: one glide from the answering node to the client.
      const back = this.spawnPacket(
        layer,
        centers[answerIndex],
        failed ? "res-fail" : "res",
      )
      await this.animateX(
        back,
        [0, centers[0] - centers[answerIndex]],
        failed ? 0.36 : 0.5,
      )
      if (this._animToken !== token) return back.remove()
      forward.remove()
      back.remove()
      this._timers.push(
        globalThis.setTimeout(() => {
          if (this._animToken !== token) return
          for (const n of nodes) {
            n.classList.remove("active", "hit-ok", "hit-fail")
          }
        }, 700),
      )
    },

    clearTimers() {
      for (const t of this._timers) clearTimeout(t)
      this._timers = []
    },

    spawnPacket(layer, x, cls) {
      const el = document.createElement("div")
      el.className = `tr-packet ${cls}`
      el.style.left = `${x}px`
      layer.append(el)
      return el
    },

    /** Animate a packet along `offsets` (px, relative to its start) in one go. */
    animateX(el, offsets, durationSec) {
      const keyframes = offsets.length > 1 ? offsets : [0, offsets[0] ?? 0]
      return new Promise((resolve) => {
        const settle = () => resolve()
        const M = globalThis.Motion
        if (M && typeof M.animate === "function") {
          // Motion's controls are thenable but expose no `.finished`.
          const controls = M.animate(
            el,
            { x: keyframes },
            { duration: durationSec, easing: [0.3, 0, 0.25, 1] },
          )
          if (controls && typeof controls.then === "function") {
            controls.then(settle, settle)
            return
          }
          if (controls && controls.finished?.then) {
            controls.finished.then(settle, settle)
            return
          }
          globalThis.setTimeout(settle, durationSec * 1000 + 60)
          return
        }
        const anim = el.animate(
          keyframes.map((o) => ({ transform: `translate3d(${o}px,0,0)` })),
          {
            duration: durationSec * 1000,
            easing: "cubic-bezier(0.3,0,0.25,1)",
            fill: "forwards",
          },
        )
        if (anim.finished?.then) {
          anim.finished.then(settle, settle)
          return
        }
        anim.onfinish = settle
        anim.oncancel = settle
      })
    },

    spawnSpark(layer, x) {
      const el = document.createElement("div")
      el.className = "tr-spark"
      el.style.left = `${x}px`
      layer.append(el)
      const anim = el.animate(
        [
          { transform: "scale(1)", opacity: 0.9 },
          { transform: "scale(4)", opacity: 0 },
        ],
        { duration: 520, easing: "ease-out" },
      )
      const remove = () => el.remove()
      if (anim.finished?.then) anim.finished.then(remove, remove)
      else anim.onfinish = remove
    },

    async replayAll() {
      this.replaying = true
      const frames = this.traces.slice()
      for (let i = 0; i < frames.length; i++) {
        if (!this.replaying) break
        this.replayIndex = i + 1
        this.select(frames[i])
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => globalThis.setTimeout(r, 550))
      }
      this.replayIndex = 0
      this.replaying = false
    },

    backToLive() {
      this.replaying = false
      if (this.traces.length) {
        this.select(this.traces[this.traces.length - 1])
      }
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
  }
}
