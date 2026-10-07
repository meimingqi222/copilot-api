function systemConfigView() {
  return {
    settings: null,
    source: "",
    expiresAt: null,
    debugMinutes: 15,
    maxLogMiB: 1024,
    acknowledgeSensitiveData: false,
    loading: false,
    saving: false,
    error: "",
    saved: false,
    codexModels: [],
    codexModelsError: "",
    codexModelSearch: "",

    get filteredCodexModels() {
      const query = this.codexModelSearch.trim().toLowerCase()
      return this.codexModels.filter((model) =>
        `${model.id} ${model.name}`.toLowerCase().includes(query),
      )
    },

    setCustomCodexModels(enabled) {
      this.settings.codexModelIds = enabled ? [] : null
      this.saved = false
    },

    toggleCodexModel(id, checked) {
      const ids = this.settings.codexModelIds
      if (!ids) return
      if (!checked)
        this.settings.codexModelIds = ids.filter((value) => value !== id)
      else if (ids.length < 100 && !ids.includes(id)) ids.push(id)
      this.saved = false
    },

    moveCodexModel(index, direction) {
      const ids = this.settings.codexModelIds
      const next = index + direction
      if (!ids || next < 0 || next >= ids.length) return
      ;[ids[index], ids[next]] = [ids[next], ids[index]]
      this.saved = false
    },

    codexModelName(id) {
      return this.codexModels.find((model) => model.id === id)?.name || id
    },

    accept(data) {
      this.settings = data.settings
      this.settings.codexModelIds ??= null
      this.maxLogMiB = Math.ceil(data.settings.logMaxTotalBytes / (1024 * 1024))
      globalThis.dispatchEvent(
        new CustomEvent("quota-display-mode", {
          detail: data.settings.quotaDisplayMode || "remaining",
        }),
      )
      this.source = data.source
      this.expiresAt = data.expiresAt
      this.acknowledgeSensitiveData = false
    },

    async load() {
      this.loading = true
      this.error = ""
      this.saved = false
      void this.loadCodexModels()
      try {
        const config = await API.request("/system-config")
        this.accept(config)
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },

    async loadCodexModels() {
      this.codexModelsError = ""
      try {
        const catalog = await API.request("/system-config/codex-models")
        this.codexModels = catalog.models
      } catch (error) {
        this.codexModels = []
        this.codexModelsError = error.message
      }
    },

    useRecommended() {
      this.settings = {
        logLevel: "info",
        requestDump: false,
        memoryVerbose: false,
        performanceDetails: true,
        codexAutoReset: false,
        codexModelIds: this.settings?.codexModelIds ?? null,
        quotaDisplayMode: "remaining",
        logRetentionDays: 7,
        logMaxTotalBytes: 1024 * 1024 * 1024,
      }
      this.maxLogMiB = 1024
      this.acknowledgeSensitiveData = false
      this.saved = false
    },

    async save() {
      if (
        this.settings.codexModelIds?.length === 0
        && !globalThis.confirm(I18n.t("system.codexModelsEmptyConfirm"))
      ) {
        return
      }
      this.saving = true
      this.error = ""
      this.saved = false
      try {
        this.accept(
          await API.request("/system-config", {
            method: "PUT",
            body: {
              ...this.settings,
              logMaxTotalBytes: Number(this.maxLogMiB) * 1024 * 1024,
              debugMinutes: Number(this.debugMinutes),
              acknowledgeSensitiveData: this.acknowledgeSensitiveData,
            },
          }),
        )
        this.saved = true
      } catch (error) {
        this.error = error.message
      } finally {
        this.saving = false
      }
    },
  }
}
