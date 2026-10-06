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

    accept(data) {
      this.settings = data.settings
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
      try {
        this.accept(await API.request("/system-config"))
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },

    useRecommended() {
      this.settings = {
        logLevel: "info",
        requestDump: false,
        memoryVerbose: false,
        performanceDetails: true,
        codexAutoReset: false,
        quotaDisplayMode: "remaining",
        logRetentionDays: 7,
        logMaxTotalBytes: 1024 * 1024 * 1024,
      }
      this.maxLogMiB = 1024
      this.acknowledgeSensitiveData = false
      this.saved = false
    },

    async save() {
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
