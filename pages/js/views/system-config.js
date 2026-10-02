function systemConfigView() {
  return {
    settings: null,
    source: "",
    expiresAt: null,
    debugMinutes: 15,
    acknowledgeSensitiveData: false,
    loading: false,
    saving: false,
    error: "",
    saved: false,

    accept(data) {
      this.settings = data.settings
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
        quotaDisplayMode: "remaining",
      }
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
