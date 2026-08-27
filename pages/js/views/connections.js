function connectionsView() {
  return {
    loading: false,
    connections: [],
    showConnModal: false,
    showCredModal: false,
    presets: [],
    presetCategory: "popular",
    presetSearchQuery: "",
    selectedPresetId: "",
    selectedPreset: null,
    showAdvanced: false,
    fetchedModels: [],
    fetchingModels: false,
    modelSearchQuery: "",
    selectedModelIds: [],
    showFetchedModelsPanel: false,
    connForm: {
      id: null,
      name: "",
      protocol: "openai-compatible",
      baseUrl: "",
      priority: 10,
      weight: 1,
      enabled: true,
      discoveryEnabled: false,
      discoveryMode: "merge",
      apiKey: "",
      _credentialId: null,
      customHeaders: [],
    },
    credForm: {
      connectionId: null,
      id: null,
      value: "",
      _protocol: "openai-compatible",
    },
    showModelModal: false,
    modelForm: {
      connectionId: null,
      originalPublicId: null,
      publicId: "",
      upstreamId: "",
    },
    showBatchModal: false,
    batchForm: {
      connectionId: null,
      rawText: "",
      models: [], // parsed: [{ publicId, upstreamId, name, vendor, selected }]
    },
    batchParsing: false,
    testing: {},
    revealedCreds: {},
    showImportModal: false,
    importFile: null,
    importSkipDuplicates: true,

    t(key, params) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },

    formatTime(ts) {
      if (!ts) return ""
      return new Date(ts).toLocaleString()
    },

    showToast(msg, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(msg, type)
    },

    statusTagClass(status) {
      switch (status) {
        case "ready": {
          return "tag-success"
        }
        case "cooldown": {
          return "tag-warning"
        }
        case "auth_error": {
          return "tag-danger"
        }
        case "quota_exhausted": {
          return "tag-danger"
        }
        case "disabled": {
          return "tag-muted"
        }
        default: {
          return "tag-info"
        }
      }
    },

    protocolColor(protocol) {
      const colors = {
        "openai-compatible": "#10a37f",
        "openai-responses-compatible": "#0a6cff",
        "anthropic-compatible": "#c96442",
        "copilot-native": "#0071e3",
        "windsurf-native": "#7c3aed",
        "codebuff-native": "#d97706",
      }
      return colors[protocol] || "#8e8e93"
    },

    async load() {
      this.loading = true
      try {
        const [data, presetsData] = await Promise.all([
          API.providerConnections.list(),
          this.presets.length === 0 ?
            API.providerConnections.presets().catch(() => ({ presets: [] }))
          : Promise.resolve({ presets: this.presets }),
        ])
        this.connections = data.connections || []
        if (presetsData?.presets) {
          this.presets = presetsData.presets
        }
      } catch (e) {
        this.showToast(e.message || "Failed to load connections", "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadPresets() {
      try {
        const data = await API.providerConnections.presets()
        this.presets = data.presets || []
      } catch {
        this.presets = []
      }
    },

    popularPresets() {
      const popularIds = new Set([
        "deepseek",
        "siliconflow",
        "moonshot",
        "zhipu",
        "openai",
        "anthropic",
        "openrouter",
        "groq",
      ])
      return this.presets.filter((p) => popularIds.has(p.id))
    },

    filteredPresets() {
      if (this.presetSearchQuery.trim()) {
        const q = this.presetSearchQuery.trim().toLowerCase()
        return this.presets.filter(
          (p) =>
            p.name.toLowerCase().includes(q)
            || p.id.toLowerCase().includes(q)
            || (p.description || "").toLowerCase().includes(q)
            || (p.baseUrl || "").toLowerCase().includes(q),
        )
      }
      return this.presetCategory === "popular" ?
          this.popularPresets()
        : this.presets.filter((p) => p.category === this.presetCategory)
    },

    selectPreset(preset) {
      if (!preset) return
      this.selectedPresetId = preset.id
      this.selectedPreset = preset
      this.connForm.name = preset.name
      this.connForm.protocol = preset.protocol
      this.connForm.baseUrl = preset.baseUrl
      this.connForm.discoveryEnabled = Boolean(preset.discoveryEnabled)
      this.connForm.discoveryMode = preset.discoveryMode || "merge"
      this.connForm.apiKey = ""
      this.fetchedModels = (preset.defaultModels || []).map((m) => ({
        publicId: m.publicId,
        upstreamId: m.upstreamId,
        name: m.name,
        endpoints:
          m.endpoints
          || (preset.protocol === "anthropic-compatible" ?
            ["messages"]
          : ["chat"]),
      }))
      this.selectedModelIds = this.fetchedModels.map((m) => m.publicId)
      this.showFetchedModelsPanel = this.fetchedModels.length > 0
      this.modelSearchQuery = ""
      this.$nextTick(() => lucide.createIcons())
    },

    selectCustomPreset() {
      this.selectedPresetId = "custom"
      this.selectedPreset = null
      this.connForm.name = ""
      this.connForm.protocol = "openai-compatible"
      this.connForm.baseUrl = ""
      this.connForm.apiKey = ""
      this.connForm.discoveryEnabled = false
      this.connForm.discoveryMode = "merge"
      this.fetchedModels = []
      this.selectedModelIds = []
      this.showFetchedModelsPanel = false
      this.modelSearchQuery = ""
      this.$nextTick(() => lucide.createIcons())
    },

    async fetchRemoteModels() {
      const form = this.connForm
      if (!form.baseUrl) {
        this.showToast(
          this.t("connections.baseUrl")
            + " "
            + (this.t("required") || "required"),
          "error",
        )
        return
      }

      const preset = this.selectedPreset
      const isLocal =
        preset?.category === "local"
        || form.baseUrl.includes("localhost")
        || form.baseUrl.includes("127.0.0.1")
      if (!form.apiKey && !form._credentialId && !isLocal) {
        this.showToast(
          this.t("connections.apiKeyRequiredForFetch")
            || "在线探测需要有效的 API Key，请先输入 API Key",
          "error",
        )
        return
      }

      const authMode =
        preset?.authMode
        || (form.protocol === "anthropic-compatible" ? "header" : "bearer")
      const headerName =
        preset?.headerName || (authMode === "header" ? "x-api-key" : undefined)

      this.fetchingModels = true
      try {
        const res = await API.providerConnections.fetchModels({
          protocol: form.protocol,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey || "",
          authMode,
          headerName,
        })
        if (res.error) {
          const msg = (res.hint ? res.hint + ": " : "") + res.error
          this.showToast(msg, "error")
          return
        }
        this.fetchedModels = res.models || []
        this.showFetchedModelsPanel = true
        this.selectedModelIds = this.fetchedModels.map((m) => m.publicId)
        this.showToast(`Fetched ${this.fetchedModels.length} models`, "success")
      } catch (e) {
        this.showToast(e.message || "Failed to fetch models", "error")
      } finally {
        this.fetchingModels = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    filteredFetchedModels() {
      const q = (this.modelSearchQuery || "").trim().toLowerCase()
      if (!q) return this.fetchedModels
      return this.fetchedModels.filter(
        (m) =>
          (m.publicId || "").toLowerCase().includes(q)
          || (m.upstreamId || "").toLowerCase().includes(q)
          || (m.vendor || "").toLowerCase().includes(q),
      )
    },

    toggleSelectAllModels() {
      this.selectedModelIds =
        this.selectedModelIds.length === this.fetchedModels.length ?
          []
        : this.fetchedModels.map((m) => m.publicId)
    },

    clearModelSelection() {
      this.selectedModelIds = []
    },

    toggleModelSelection(publicId) {
      this.selectedModelIds =
        this.selectedModelIds.includes(publicId) ?
          this.selectedModelIds.filter((id) => id !== publicId)
        : [...this.selectedModelIds, publicId]
    },

    isModelSelected(publicId) {
      return this.selectedModelIds.includes(publicId)
    },

    addCustomHeader() {
      this.connForm.customHeaders.push({ key: "", value: "" })
    },

    removeCustomHeader(index) {
      this.connForm.customHeaders.splice(index, 1)
    },

    customHeadersToRecord() {
      const record = {}
      for (const h of this.connForm.customHeaders) {
        const key = (h.key || "").trim()
        if (!key) continue
        record[key] = h.value || ""
      }
      return Object.keys(record).length > 0 ? record : undefined
    },

    openCreate(presetId) {
      this.connForm = {
        id: null,
        name: "",
        protocol: "openai-compatible",
        baseUrl: "",
        priority: 10,
        weight: 1,
        enabled: true,
        discoveryEnabled: false,
        discoveryMode: "merge",
        apiKey: "",
        _credentialId: null,
        customHeaders: [],
      }
      this.showAdvanced = false
      this.presetSearchQuery = ""
      this.showConnModal = true

      const initPresets = async () => {
        if (this.presets.length === 0) {
          await this.loadPresets()
        }
        if (presetId) {
          const target = this.presets.find((p) => p.id === presetId)
          if (target) {
            this.presetCategory = target.category || "popular"
            this.selectPreset(target)
            return
          }
        }
        // 默认选中 deepseek
        const defaultPreset =
          this.presets.find((p) => p.id === "deepseek") || this.presets[0]
        if (defaultPreset) {
          this.presetCategory = "popular"
          this.selectPreset(defaultPreset)
        }
      }

      initPresets().finally(() => {
        this.$nextTick(() => lucide.createIcons())
      })
    },

    openEdit(conn) {
      const headerEntries = Object.entries(conn.headers || {})
      this.connForm = {
        id: conn.id,
        name: conn.name,
        protocol: conn.protocol,
        baseUrl: conn.baseUrl,
        priority: conn.priority,
        weight: conn.weight ?? 1,
        enabled: conn.enabled,
        discoveryEnabled: Boolean(conn.modelDiscovery?.enabled),
        discoveryMode: conn.modelDiscovery?.mode || "merge",
        apiKey: "",
        _credentialId: conn.credentials?.[0]?.id || null,
        customHeaders: headerEntries.map(([key, value]) => ({ key, value })),
      }
      this.selectedPresetId = ""
      this.selectedPreset = null
      this.showAdvanced = true
      this.fetchedModels = (conn.models || []).map((m) => ({
        publicId: m.publicId,
        upstreamId: m.upstreamId || m.publicId,
        vendor: m.vendor,
        endpoints: m.endpoints || [],
      }))
      this.selectedModelIds = this.fetchedModels.map((m) => m.publicId)
      this.showFetchedModelsPanel = this.fetchedModels.length > 0
      this.showConnModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    async saveConn() {
      const form = this.connForm
      if (!form.name || !form.baseUrl) {
        this.showToast("Name and Base URL are required", "error")
        return
      }

      const selectedModels = this.fetchedModels
        .filter((m) => this.selectedModelIds.includes(m.publicId))
        .map((m) => ({
          publicId: m.publicId,
          upstreamId: m.upstreamId || m.publicId,
          vendor: m.vendor,
          endpoints:
            m.endpoints
            || (form.protocol === "anthropic-compatible" ?
              ["messages"]
            : ["chat"]),
          enabled: true,
          pickerEnabled: true,
        }))

      const payload = {
        name: form.name,
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        priority: form.priority,
        weight: form.weight,
        enabled: form.enabled,
        modelDiscovery: {
          enabled: form.discoveryEnabled,
          mode: form.discoveryMode,
        },
        models: selectedModels,
        headers: this.customHeadersToRecord(),
      }

      const preset = this.selectedPreset
      const credAuth =
        (
          preset?.authMode === "header"
          || form.protocol === "anthropic-compatible"
        ) ?
          { authMode: "header", headerName: preset?.headerName || "x-api-key" }
        : { authMode: "bearer" }

      try {
        let connId
        if (form.id) {
          await API.providerConnections.update(form.id, payload)
          connId = form.id
          if (form.apiKey) {
            const credPayload = { ...credAuth, value: form.apiKey }
            await (form._credentialId ?
              API.providerConnections.updateCredential(
                connId,
                form._credentialId,
                credPayload,
              )
            : API.providerConnections.addCredential(connId, {
                ...credPayload,
                enabled: true,
              }))
          }
        } else {
          const createPayload = {
            ...payload,
            credentials:
              form.apiKey ?
                [{ ...credAuth, value: form.apiKey, enabled: true }]
              : undefined,
          }
          const res = await API.providerConnections.create(createPayload)
          connId = res.connection.id
        }
        this.showConnModal = false
        await this.load()
        this.showToast("Saved", "success")
      } catch (e) {
        this.showToast(e.message || "Save failed", "error")
      }
    },

    async deleteConn(conn) {
      if (!confirm('Delete connection "' + conn.name + '"?')) return
      try {
        await API.providerConnections.delete(conn.id)
        await this.load()
        this.showToast("Deleted", "success")
      } catch (e) {
        this.showToast(e.message || "Delete failed", "error")
      }
    },

    async refreshModels(conn) {
      try {
        const res = await API.providerConnections.refreshModels(conn.id)
        await this.load()
        this.showToast(
          "Discovered " + (res.discovered ?? 0) + " model(s)",
          "success",
        )
      } catch (e) {
        this.showToast(e.message || "Refresh failed", "error")
      }
    },

    openAddCredential(conn) {
      this.credForm = {
        connectionId: conn.id,
        id: null,
        value: "",
        _protocol: conn.protocol,
      }
      this.showCredModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    openEditCredential(conn, cred) {
      this.credForm = {
        connectionId: conn.id,
        id: cred.id,
        value: "",
        _protocol: conn.protocol,
      }
      this.showCredModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    async saveCred() {
      const form = this.credForm
      const credAuth =
        form._protocol === "anthropic-compatible" ?
          { authMode: "header", headerName: "x-api-key" }
        : { authMode: "bearer" }
      try {
        if (form.id) {
          if (!form.value) {
            this.showToast("请输入新的 API Key", "error")
            return
          }
          await API.providerConnections.updateCredential(
            form.connectionId,
            form.id,
            { ...credAuth, value: form.value },
          )
        } else {
          const keys = form.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
          if (keys.length === 0) {
            this.showToast("请输入至少一个 API Key", "error")
            return
          }
          for (const key of keys) {
            await API.providerConnections.addCredential(form.connectionId, {
              ...credAuth,
              value: key,
              enabled: true,
            })
          }
        }
        this.showCredModal = false
        await this.load()
        this.showToast("Saved", "success")
      } catch (e) {
        this.showToast(e.message || "Save failed", "error")
      }
    },

    async toggleCredential(conn, cred) {
      try {
        await (cred.enabled ?
          API.providerConnections.disableCredential(conn.id, cred.id)
        : API.providerConnections.enableCredential(conn.id, cred.id))
        await this.load()
      } catch (e) {
        this.showToast(e.message || "Failed", "error")
      }
    },

    async resetCredential(conn, cred) {
      try {
        await API.providerConnections.resetCredentialStatus(conn.id, cred.id)
        await this.load()
        this.showToast("Status reset", "success")
      } catch (e) {
        this.showToast(e.message || "Failed", "error")
      }
    },

    async testCred(conn, cred) {
      this.testing = { ...this.testing, [cred.id]: true }
      try {
        const res = await API.providerConnections.testConnection(
          conn.id,
          cred.id,
        )
        const ms = res.latencyMs ?? 0
        if (res.ok) {
          const detail =
            res.method === "chat" || res.method === "messages" ?
              res.modelId ?
                ` (${res.method}: ${res.modelId}, ${ms}ms)`
              : ` (${res.method}, ${ms}ms)`
            : res.method === "model-list" ? ` (models, ${ms}ms)`
            : ` (${ms}ms)`
          this.showToast(this.t("connections.testSuccess") + detail, "success")
          // Successful probe clears sticky 429/cooldown on the server; refresh UI.
          await this.load()
        } else {
          this.showToast(
            this.t("connections.testFailed")
              + ": "
              + (res.error || `HTTP ${res.status}`),
            "error",
          )
        }
      } catch (e) {
        this.showToast(
          this.t("connections.testFailed") + ": " + e.message,
          "error",
        )
      } finally {
        const t = { ...this.testing }
        delete t[cred.id]
        this.testing = t
      }
    },

    async testAllCreds() {
      const allCreds = this.connections.flatMap((conn) =>
        (conn.credentials || [])
          .filter((c) => c.enabled)
          .map((cred) => ({ conn, cred })),
      )
      if (allCreds.length === 0) {
        this.showToast("No enabled credentials", "error")
        return
      }
      const init = {}
      for (const { cred } of allCreds) {
        init[cred.id] = true
      }
      this.testing = { ...this.testing, ...init }
      const results = await Promise.allSettled(
        allCreds.map(({ conn, cred }) =>
          API.providerConnections
            .testConnection(conn.id, cred.id)
            .then((res) => ({ ok: res.ok })),
        ),
      )
      const t = { ...this.testing }
      for (const { cred } of allCreds) delete t[cred.id]
      this.testing = t
      const ok = results.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      ).length
      this.showToast(
        `${ok}/${allCreds.length} 连通正常`,
        ok === allCreds.length ? "success" : "error",
      )
      await this.load()
    },

    async exportConnections() {
      try {
        const response = await API.providerConnections.export()
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename =
          match ? match[1] : "copilot-api-provider-connections.json"
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(this.t("connections.exportSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || this.t("error.load"), "error")
      }
    },

    async exportOneConnection(conn) {
      try {
        const response = await API.providerConnections.exportOne(conn.id)
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename =
          match ? match[1] : `copilot-api-provider-connection-${conn.id}.json`
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(this.t("connections.exportOneSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || this.t("error.load"), "error")
      }
    },

    openImportModal() {
      this.importFile = null
      this.importSkipDuplicates = true
      this.showImportModal = true
      this.$nextTick(() => {
        if (this.$refs.connImportFileInput)
          this.$refs.connImportFileInput.value = ""
        lucide.createIcons()
      })
    },

    closeImportModal() {
      this.showImportModal = false
      this.importFile = null
    },

    importFileSelected(event) {
      this.importFile = event.target.files[0] || null
    },

    async submitImport() {
      if (!this.importFile) {
        this.showToast(this.t("connections.importNoFile"), "error")
        return
      }
      let parsed
      try {
        const text = await this.importFile.text()
        parsed = JSON.parse(text)
      } catch {
        this.showToast(this.t("connections.importInvalidFile"), "error")
        return
      }
      const connections =
        Array.isArray(parsed) ? parsed : (
          parsed.connections || (parsed.baseUrl ? [parsed] : [])
        )
      if (!Array.isArray(connections) || connections.length === 0) {
        this.showToast(this.t("connections.importInvalidFile"), "error")
        return
      }
      try {
        const result = await API.providerConnections.import({
          connections,
          overwrite: !this.importSkipDuplicates,
        })
        let msg = this.t("connections.importSuccess", {
          count: result.imported,
        })
        if (result.skipped > 0) {
          msg += this.t("connections.importSkipped", { count: result.skipped })
        }
        if (result.failed > 0) {
          msg += this.t("connections.importFailed", { count: result.failed })
        }
        this.showToast(msg, result.imported > 0 ? "success" : "info")
        this.closeImportModal()
        await this.load()
      } catch (e) {
        this.showToast(e.message || this.t("error.create"), "error")
      }
    },

    openAddModel(conn) {
      this.modelForm = {
        connectionId: conn.id,
        originalPublicId: null,
        publicId: "",
        upstreamId: "",
      }
      this.showModelModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    openEditModel(conn, model) {
      this.modelForm = {
        connectionId: conn.id,
        originalPublicId: model.publicId,
        publicId: model.publicId,
        upstreamId: model.upstreamId || "",
      }
      this.showModelModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    async saveModel() {
      const f = this.modelForm
      if (!f.publicId.trim()) {
        this.showToast("Public ID is required", "error")
        return
      }
      const payload = {
        publicId: f.publicId.trim(),
        upstreamId: f.upstreamId.trim() || undefined,
      }
      try {
        await (f.originalPublicId ?
          API.providerConnections.updateModel(
            f.connectionId,
            f.originalPublicId,
            payload,
          )
        : API.providerConnections.addModel(f.connectionId, payload))
        this.showModelModal = false
        await this.load()
        this.showToast("Saved", "success")
      } catch (e) {
        this.showToast(e.message || "Save failed", "error")
      }
    },

    async toggleModel(conn, model) {
      try {
        await API.providerConnections.updateModel(conn.id, model.publicId, {
          enabled: !model.enabled,
        })
        model.enabled = !model.enabled
      } catch (e) {
        this.showToast(e.message || "Toggle failed", "error")
      }
    },

    // ── 批量添加模型 ──────────────────────────────────────────────

    openBatchAddModel(conn) {
      this.batchForm = {
        connectionId: conn.id,
        rawText: "",
        models: [],
      }
      this.showBatchModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    /**
     * 解析粘贴的模型清单文本。
     * 支持格式:
     *  - Markdown 表格: | Model | Model ID |
     *  - 制表符/多空格分隔: Name<TAB>model-id
     *  - YAML-like: - name: id
     *  - "Name: ID" 单行
     *  - 纯 ID 列表(每行一个)
     *
     * 若第二列含 `/` 前缀(如 cline-pass/glm-5.2),自动拆分:
     *  - 前缀 → vendor
     *  - 后段 → publicId
     *  - 完整字符串 → upstreamId
     *
     * 默认勾选 publicId 匹配 "deepseek-v4-flash" 的项。
     */
    parseBatchModels() {
      const text = this.batchForm.rawText || ""
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const models = []

      // 表头关键词,跳过
      const HEADER_RE = /^(?:model|model\s*id|name|id|模型|名称|编号)$/i

      for (const rawLine of lines) {
        // 去除 markdown 表格装饰 | ... |
        let line = rawLine
        if (line.startsWith("|")) line = line.slice(1)
        if (line.endsWith("|")) line = line.slice(0, -1)

        // 跳过 markdown 分隔行 |---|---|
        if (/^[\s|:-]+$/.test(line)) continue

        // 按制表符或 2+ 空格分列
        let parts = line.split(/\t/)
        if (parts.length === 1) {
          parts = line.split(/\s{2,}/)
        }
        // YAML-like "- name: id"
        if (parts.length === 1 && /^[-*]\s+/.test(parts[0])) {
          const rest = parts[0].replace(/^[-*]\s+/, "")
          parts =
            rest.includes(":") ?
              rest
                .split(/:(.*)/)
                .map((s) => s.trim())
                .filter(Boolean)
            : [rest]
        }
        // "Name: ID" 单行
        if (parts.length === 1 && parts[0].includes(":")) {
          const idx = parts[0].indexOf(":")
          const head = parts[0].slice(0, idx).trim()
          const tail = parts[0].slice(idx + 1).trim()
          if (head && tail && !head.includes("://")) {
            parts = [head, tail]
          }
        }

        parts = parts.map((p) => p.trim()).filter(Boolean)
        if (parts.length === 0) continue

        let name = ""
        let idStr
        if (parts.length >= 2) {
          name = parts[0]
          idStr = parts[1]
        } else {
          idStr = parts[0]
        }

        if (HEADER_RE.test(name) || HEADER_RE.test(idStr)) continue

        // 拆分 provider 前缀: "cline-pass/glm-5.2" → vendor="cline-pass", publicId="glm-5.2"
        let publicId = idStr
        let upstreamId = idStr
        let vendor = undefined
        const slashIdx = idStr.lastIndexOf("/")
        if (slashIdx > 0 && slashIdx < idStr.length - 1) {
          vendor = idStr.slice(0, slashIdx)
          publicId = idStr.slice(slashIdx + 1)
          upstreamId = idStr
        }

        models.push({
          publicId,
          upstreamId,
          name: name || undefined,
          vendor,
          selected: publicId === "deepseek-v4-flash",
        })
      }

      this.batchForm.models = models
      if (models.length === 0) {
        this.showToast("No models parsed", "error")
      } else {
        this.showToast(
          `Parsed ${models.length} model(s), ${models.filter((m) => m.selected).length} selected`,
          "success",
        )
      }
    },

    /** 调用 LLM 智能解析粘贴文本,适配任意格式。 */
    async aiParseBatchModels() {
      const text = (this.batchForm.rawText || "").trim()
      if (!text) {
        this.showToast("Please paste model list text first", "error")
        return
      }
      this.batchParsing = true
      try {
        const res = await API.providerConnections.parseModelsWithAI(text)
        const raw = Array.isArray(res.models) ? res.models : []
        if (raw.length === 0) {
          this.showToast("AI found no models", "error")
          return
        }
        const models = raw
          .map((m) => ({
            publicId: String(m.publicId || "").trim(),
            upstreamId: String(m.upstreamId || m.publicId || "").trim(),
            name: m.name ? String(m.name) : undefined,
            vendor: m.vendor ? String(m.vendor) : undefined,
            selected: String(m.publicId || "") === "deepseek-v4-flash",
          }))
          .filter((m) => m.publicId)
        this.batchForm.models = models
        this.showToast(
          `AI parsed ${models.length} model(s), ${models.filter((m) => m.selected).length} selected`,
          "success",
        )
      } catch (e) {
        this.showToast(e.message || "AI parse failed", "error")
      } finally {
        this.batchParsing = false
      }
    },

    toggleBatchModel(m) {
      m.selected = !m.selected
    },

    selectAllBatchModels() {
      const allSelected = this.batchForm.models.every((m) => m.selected)
      for (const m of this.batchForm.models) m.selected = !allSelected
    },

    async saveBatchModels() {
      const selected = this.batchForm.models.filter((m) => m.selected)
      if (selected.length === 0) {
        this.showToast("No models selected", "error")
        return
      }
      const payload = selected.map((m) => ({
        publicId: m.publicId,
        upstreamId: m.upstreamId,
        name: m.name,
        vendor: m.vendor,
        enabled: true,
      }))
      try {
        const res = await API.providerConnections.batchAddModels(
          this.batchForm.connectionId,
          payload,
        )
        this.showBatchModal = false
        await this.load()
        const msg =
          `Added ${res.added?.length || 0}`
          + (res.skipped?.length ? `, skipped ${res.skipped.length}` : "")
        this.showToast(msg, "success")
      } catch (e) {
        this.showToast(e.message || "Batch add failed", "error")
      }
    },

    async deleteModel(conn, model) {
      if (!confirm(`Delete model "${model.publicId}"?`)) return
      try {
        await API.providerConnections.deleteModel(conn.id, model.publicId)
        await this.load()
        this.showToast("Deleted", "success")
      } catch (e) {
        this.showToast(e.message || "Delete failed", "error")
      }
    },

    async revealCred(conn, cred) {
      if (this.revealedCreds[cred.id]) {
        const copy = { ...this.revealedCreds }
        delete copy[cred.id]
        this.revealedCreds = copy
        return
      }
      try {
        const res = await API.providerConnections.revealCredential(
          conn.id,
          cred.id,
        )
        this.revealedCreds = { ...this.revealedCreds, [cred.id]: res.value }
      } catch (e) {
        this.showToast(e.message || "Failed to reveal", "error")
      }
    },

    async deleteCredential(conn, cred) {
      if (!confirm("Delete credential?")) return
      try {
        await API.providerConnections.deleteCredential(conn.id, cred.id)
        await this.load()
      } catch (e) {
        this.showToast(e.message || "Failed", "error")
      }
    },
  }
}

// Quota View Component
