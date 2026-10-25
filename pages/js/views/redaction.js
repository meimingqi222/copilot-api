function redactionView() {
  return {
    settings: null,
    appliedRedaction: null,
    source: "",
    tab: "rules",
    liveActive: false,
    liveTimer: null,
    motionPaused: false,
    animationPaused: false,
    loading: false,
    saving: false,
    saved: false,
    error: "",
    loadVersion: 0,
    redactionWordsText: "",
    redactionHomePrefixesText: "",
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
    detailComparison: false,
    detailLoading: false,
    detailError: "",
    detailVersion: 0,
    detailController: null,

    init() {
      for (const field of [
        "previewText",
        "previewFormat",
        "settings",
        "redactionWordsText",
        "redactionHomePrefixesText",
      ])
        this.$watch(field, () => this.invalidatePreview())
    },

    accept(data) {
      this.invalidatePreview()
      this.appliedRedaction = data.settings.redaction
      this.settings = { redaction: { ...data.settings.redaction } }
      this.redactionWordsText = this.settings.redaction.words.join("\n")
      this.redactionHomePrefixesText =
        this.settings.redaction.homePrefixes.join("\n")
      this.source = data.source
    },

    enterRedaction() {
      this.liveActive = true
      void this.load()
      this.syncLive()
    },

    syncLive() {
      if (this.liveTimer !== null) clearTimeout(this.liveTimer)
      this.liveTimer = null
      this.motionPaused = !this.liveActive || document.hidden
      if (this.motionPaused) {
        this.clearDetail()
        this.clearPreview()
        this.cancelInspectionRequest()
        this.statsVersion++
        this.statsController?.abort()
        this.statsController = null
        this.redactionStatsLoading = false
        return
      }
      this.liveTimer = setTimeout(async () => {
        this.liveTimer = null
        await this.loadRedactionStats(true)
        this.syncLive()
      }, 2500)
    },

    async load() {
      const version = ++this.loadVersion
      this.loading = true
      this.error = ""
      this.saved = false
      void this.loadRedactionStats()
      try {
        const data = await API.request("/system-config")
        if (version === this.loadVersion) this.accept(data)
      } catch (error) {
        if (version === this.loadVersion) this.error = error.message
      } finally {
        if (version === this.loadVersion) this.loading = false
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
      return {
        ...this.settings.redaction,
        words: lines(this.redactionWordsText),
        homePrefixes: lines(this.redactionHomePrefixesText),
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
      this.redactionStatsError = ""
      try {
        const data = await API.request("/system-config/redaction-stats", {
          signal: controller.signal,
          cache: "no-store",
        })
        if (version === this.statsVersion) {
          this.acceptInspection(data.inspection)
          this.redactionStats = data.entries.slice(0, 100).map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            client: typeof entry.client === "string" ? entry.client : "",
            upstreams: (entry.upstreams || []).map((upstream) => ({
              id: upstream.id,
              name: upstream.name,
              protocol: upstream.protocol,
              model: upstream.model,
            })),
            contentAvailable: entry.contentAvailable === true,
            total: entry.total,
            byKind: Object.fromEntries(
              ["SECRET", "HOME", "WORD"].map((kind) => [
                kind,
                entry.byKind[kind],
              ]),
            ),
            bySource: Object.fromEntries(
              ["builtin", "word", "homePrefix", "field", "known"].map(
                (source) => [source, entry.bySource[source]],
              ),
            ),
            maskingMs: entry.maskingMs,
            restored: entry.restored,
          }))
          if (
            this.detailId !== null
            && (!this.inspection.enabled
              || !this.redactionStats.some(
                (entry) => entry.id === this.detailId && entry.contentAvailable,
              ))
          )
            this.clearDetail()
        }
      } catch {
        if (version === this.statsVersion)
          this.redactionStatsError = "system.redaction.statsError"
      } finally {
        if (version === this.statsVersion) {
          this.redactionStatsLoading = false
          this.statsController = null
        }
      }
    },

    get redactionStatsTotal() {
      return this.redactionStats.reduce((sum, entry) => sum + entry.total, 0)
    },

    routeGroups(side) {
      const groups = new Map()
      for (const entry of this.redactionStats) {
        const endpoints =
          side === "client" ? [{ id: entry.client, name: entry.client }]
          : entry.upstreams.length ? entry.upstreams
          : [{ id: "", name: "" }]
        const seen = new Set()
        for (const endpoint of endpoints) {
          const id = endpoint.id || ""
          if (seen.has(id)) continue
          seen.add(id)
          if (!groups.has(id))
            groups.set(id, { id, name: endpoint.name || id, count: 0 })
          groups.get(id).count++
        }
      }
      return [...groups.values()].sort(
        (a, b) => b.count - a.count || a.id.localeCompare(b.id),
      )
    },

    get filteredRecords() {
      return this.redactionStats.filter(
        (entry) =>
          (this.clientFilter === null || entry.client === this.clientFilter)
          && (this.upstreamFilter === null
            || (entry.upstreams.length ?
              entry.upstreams.some(
                (item) => (item.id || "") === this.upstreamFilter,
              )
            : this.upstreamFilter === "")),
      )
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
      this.detail = null
      this.detailRevealed = false
      this.detailComparison = false
      this.detailLoading = false
      this.detailError = ""
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
        bytes: value?.bytes,
      }
      const remaining =
        new Date(this.inspection.expiresAt).getTime() - Date.now()
      if (!this.inspection.enabled || !(remaining > 0)) {
        this.inspection.enabled = false
        this.clearDetail()
        return
      }
      this.inspectionTimer = setTimeout(() => {
        this.inspection.enabled = false
        this.inspectionTimer = null
        this.clearDetail()
      }, remaining)
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
      // Invalidate any metadata response started before this mutation.
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
            : { body: { enabled: action === "enable" } }),
            signal: controller.signal,
            cache: "no-store",
          },
        )
        if (version !== this.inspectionVersion) return
        this.acceptInspection(data.inspection || data)
        if (action !== "enable")
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

    async loadDetail(id, reveal = false) {
      this.clearDetail()
      if (
        !this.inspection.enabled
        || this.inspectionBusy
        || new Date(this.inspection.expiresAt).getTime() <= Date.now()
        || !this.redactionStats.some(
          (entry) => entry.id === id && entry.contentAvailable,
        )
      )
        return
      this.detailId = id
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
          input: reveal ? data.input : null,
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
            parts: this.contentParts(attempt.body, data.mappings),
          })),
          mappings: data.mappings.map((mapping) => ({
            placeholder: mapping.placeholder,
            kind: mapping.kind,
            source: mapping.source,
            ...(reveal ? { value: mapping.value } : {}),
          })),
          truncated: data.truncated,
        }
        this.detailRevealed = reveal
        this.detailComparison = reveal
      } catch {
        if (version === this.detailVersion)
          this.detailError = "redaction.inspect.error"
      } finally {
        if (version === this.detailVersion) {
          this.detailLoading = false
          this.detailController = null
        }
      }
    },

    contentParts(body, mappings) {
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
          ...leaf.text.matchAll(/\{\{(?:SECRET|HOME|WORD)_[a-f0-9]{32}\}\}/g),
        ].some((match) => known.has(match[0]))
        if (changed) parts.push({ ...leaf, changed: true })
        else {
          if (!parts.length || parts.at(-1).changed)
            parts.push({ changed: false, leaves: [] })
          parts.at(-1).leaves.push(leaf)
        }
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
        ...text.matchAll(/\{\{(?:SECRET|HOME|WORD)_[a-f0-9]{32}\}\}/g),
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
            text:
              (
                original
                && this.detailRevealed
                && typeof mapping.value === "string"
              ) ?
                mapping.value
              : hit[0],
            kind: mapping.kind,
          })
          at = hit.index + hit[0].length
        }
        if (at < end) segments.push({ text: text.slice(at, end), kind: "" })
        previous = end
      }
      if (previous < text.length) segments.push({ text: "…", kind: "" })
      return segments
    },

    kindTotal(kind) {
      return this.redactionStats.reduce(
        (sum, entry) => sum + entry.byKind[kind],
        0,
      )
    },

    redactionCounts(counts, group) {
      void this.lang
      const keys =
        group === "kind" ?
          ["SECRET", "HOME", "WORD"]
        : ["builtin", "word", "homePrefix", "field", "known"]
      return keys
        .map(
          (key) => `${I18n.t("system.redaction." + key)}: ${counts[key] || 0}`,
        )
        .join(" · ")
    },
  }
}
