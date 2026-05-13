function connectionsView() {
  return {
    loading: false,
    connections: [],
    showConnModal: false,
    showCredModal: false,
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
    testing: {},
    revealedCreds: {},

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
        const data = await API.providerConnections.list()
        this.connections = data.connections || []
      } catch (e) {
        this.showToast(e.message || "Failed to load connections", "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    openCreate() {
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
      }
      this.showConnModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    openEdit(conn) {
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
      }
      this.showConnModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    async saveConn() {
      const form = this.connForm
      if (!form.name || !form.baseUrl) {
        this.showToast("Name and Base URL are required", "error")
        return
      }
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
      }
      const credAuth =
        form.protocol === "anthropic-compatible" ?
          { authMode: "header", headerName: "x-api-key" }
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
          const res = await API.providerConnections.create(payload)
          connId = res.connection.id
          if (form.apiKey) {
            await API.providerConnections.addCredential(connId, {
              ...credAuth,
              value: form.apiKey,
              enabled: true,
            })
          }
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
          this.showToast(
            this.t("connections.testSuccess") + ` (${ms}ms)`,
            "success",
          )
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
