const MANUAL_OAUTH_CALLBACK_PROVIDERS = new Set([
  "claude",
  "codex",
  "xai",
  "antigravity",
])

function accountsView() {
  return {
    loading: false,
    accounts: [],
    providers: [],
    showAddModal: false,
    showImportModal: false,
    importFile: null,
    importSkipDuplicates: true,
    importMode: "standard",
    defaultNewAccount() {
      return {
        label: "",
        provider: "copilot",
        credentials: {},
        settings: {},
      }
    },
    newAccount: {
      label: "",
      provider: "copilot",
      credentials: {},
      settings: {},
    },
    deviceFlowStep: "input",
    deviceFlowData: null,
    oauthFlowData: null,
    oauthCallbackInput: "",
    oauthCallbackSubmitting: false,
    pollTimer: null,
    refreshingQuotaId: null,
    mimoCookieInput: "",

    parseMimoCookie() {
      const str = this.mimoCookieInput
      if (!str) return
      const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/g
      let m
      while ((m = re.exec(str)) !== null) {
        const val = m[2] ?? m[3] ?? m[4] ?? ""
        switch (m[1]) {
          case "serviceToken": {
            this.setAccountFieldValue(
              { key: "serviceToken", type: "secret" },
              val.trim(),
            )
            break
          }
          case "xiaomichatbot_ph": {
            this.setAccountFieldValue(
              { key: "xiaomichatbotPh", type: "secret" },
              val.trim(),
            )
            break
          }
          case "userId": {
            this.setAccountFieldValue(
              { key: "userId", type: "text" },
              val.trim(),
            )
            break
          }
          default: {
            break
          }
        }
      }
    },
    editingLabel: null,
    editLabelValue: "",
    modelSearch: {},

    async load() {
      this.loading = true
      try {
        const [data, providerData] = await Promise.all([
          API.accounts.list(),
          API.providers.list(),
        ])
        this.accounts = data.accounts || []
        this.providers = providerData.providers || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    providerIcon(providerId) {
      const provider = this.providers.find((item) => item.id === providerId)
      return (
        provider?.icon
        || (providerId === "codebuff" ? "bot"
        : providerId === "windsurf" ? "wind"
        : "github")
      )
    },

    providerLabel(providerId) {
      const provider = this.providers.find((item) => item.id === providerId)
      return (
        provider?.name
        || I18n.t(`accounts.provider.${providerId}.name`)
        || providerId
      )
    },

    selectedProvider() {
      return (
        this.providers.find(
          (provider) => provider.id === this.newAccount.provider,
        ) || null
      )
    },

    selectedProviderFields() {
      return this.selectedProvider()?.accountFields || []
    },

    fieldLabel(field) {
      return I18n.t(field.labelKey) || field.key
    },

    getAccountFieldValue(field) {
      if (field.key in (this.newAccount.credentials || {})) {
        return this.newAccount.credentials[field.key]
      }
      return this.newAccount.settings?.[field.key]
    },

    setAccountFieldValue(field, value) {
      if (field.type === "secret") {
        this.newAccount.credentials = {
          ...this.newAccount.credentials,
          [field.key]: value,
        }
        return
      }

      this.newAccount.settings = {
        ...this.newAccount.settings,
        [field.key]: value,
      }
    },

    startEditLabel(account) {
      this.editingLabel = account.id
      this.editLabelValue = account.label
      this.$nextTick(() => {
        const input = this.$refs.labelInput
        if (input) input.focus()
      })
    },

    async saveLabel(account) {
      if (!this.editLabelValue.trim()) {
        this.editingLabel = null
        return
      }
      try {
        await API.accounts.update(account.id, {
          label: this.editLabelValue.trim(),
        })
        this.showToast(
          I18n.t("accounts.updateSuccess") || "Account name updated",
          "success",
        )
        await this.load()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      } finally {
        this.editingLabel = null
      }
    },

    needsManualOAuthCallback(provider = this.newAccount.provider) {
      return MANUAL_OAUTH_CALLBACK_PROVIDERS.has(provider)
    },

    oauthCallbackLabel() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackLabel`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackLabel")
    },

    oauthCallbackPlaceholder() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackPlaceholder`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackPlaceholder")
    },

    oauthCallbackHint() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackHint`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackHint")
    },

    async cancelOAuthFlow() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      if (!flowId || this.selectedProvider()?.authMode !== "oauth") {
        return
      }
      try {
        await API.oauth.cancel(provider, { flowId })
      } catch {
        // Ignore cancel errors.
      }
    },

    openAddModal() {
      this.newAccount = this.defaultNewAccount()
      this.deviceFlowStep = "input"
      this.deviceFlowData = null
      this.oauthFlowData = null
      this.oauthCallbackInput = ""
      this.oauthCallbackSubmitting = false
      this.showAddModal = true
      if (this.pollTimer) clearTimeout(this.pollTimer)
      this.pollTimer = null
    },

    async closeAddModal() {
      if (this.deviceFlowStep === "pending") {
        await this.cancelOAuthFlow()
      }

      this.showAddModal = false
      this.newAccount = this.defaultNewAccount()
      this.deviceFlowStep = "input"
      this.deviceFlowData = null
      this.oauthFlowData = null
      this.oauthCallbackInput = ""
      this.oauthCallbackSubmitting = false
      if (this.pollTimer) {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
      }
    },

    async submitAccount() {
      this.pollTimer = null
      try {
        const authMode = this.selectedProvider()?.authMode
        if (authMode === "oauth") {
          try {
            await this.startOAuthFlow()
          } catch (error) {
            const message =
              error instanceof Error ? error.message : I18n.t("error.create")
            this.showToast(message, "error")
          }
          return
        }

        const provider = this.newAccount.provider || "copilot"
        const payload = {
          label: this.newAccount.label.trim() || undefined,
          provider,
          credentials: Object.fromEntries(
            Object.entries(this.newAccount.credentials || {}).filter(
              ([, value]) => value !== "" && value !== undefined,
            ),
          ),
          settings: Object.fromEntries(
            Object.entries(this.newAccount.settings || {}).filter(
              ([, value]) => value !== "" && value !== undefined,
            ),
          ),
        }
        const res = await API.accounts.create(payload)
        if (this.selectedProvider()?.authMode === "device_flow") {
          if (!res?.flowId || !res?.userCode || !res?.verificationUri) {
            throw new Error("Invalid device flow response")
          }
          this.deviceFlowData = res
          this.deviceFlowStep = "pending"
          this.pollDeviceFlow()
          return
        }
        if (res?.status && res.status !== "complete") {
          throw new Error("Unexpected account creation status")
        }
        this.deviceFlowStep = "success"
        await this.load()
      } catch {
        this.showToast(I18n.t("error.create"), "error")
      }
    },

    pollDeviceFlow() {
      let pollInterval = this.deviceFlowData?.interval * 1000 || 5000

      const doPoll = async () => {
        if (this.deviceFlowStep !== "pending") {
          return
        }
        try {
          const flowId =
            this.deviceFlowData.flowId || this.deviceFlowData.deviceCode
          const res = await API.accountFlows.poll(flowId)
          if (res.status === "complete") {
            this.deviceFlowStep = "success"
            // Refresh accounts list to show the new account
            await this.load()
            return
          }
          if (res.status === "expired") {
            this.deviceFlowStep = "input"
            this.showToast(
              I18n.t("accounts.deviceFlow.expired")
                || "Device flow expired. Please try again.",
              "error",
            )
            return
          }
          // Update interval if server asks for slow_down
          if (res.interval) {
            pollInterval = res.interval * 1000
          }
        } catch {
          // Continue polling
        }
        // Schedule next poll with current interval
        this.pollTimer = setTimeout(doPoll, pollInterval)
      }

      this.pollTimer = setTimeout(doPoll, pollInterval)
    },

    async startOAuthFlow() {
      const provider = this.newAccount.provider
      const proxyUrl = this.newAccount.settings?.proxyUrl?.trim()
      const manual = this.needsManualOAuthCallback(provider)
      const res = await API.oauth.start(provider, {
        label: this.newAccount.label.trim() || undefined,
        proxyUrl: proxyUrl || undefined,
        manual,
      })
      if (!res?.flowId) {
        throw new Error("Invalid OAuth flow response")
      }
      this.oauthFlowData = res
      this.oauthCallbackInput = ""
      this.deviceFlowStep = "pending"
      if (res.authUrl) {
        globalThis.open(res.authUrl, "_blank", "noopener,noreferrer")
      } else if (res.verificationUri) {
        globalThis.open(res.verificationUri, "_blank", "noopener,noreferrer")
      }
      this.pollOAuthFlow()
    },

    async submitOAuthCallback() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      const callback = this.oauthCallbackInput.trim()
      if (!flowId || !callback) {
        this.showToast(
          provider === "xai" ?
            I18n.t("accounts.oauth.xaiCallbackRequired")
          : I18n.t("accounts.oauth.callbackRequired"),
          "error",
        )
        return
      }

      this.oauthCallbackSubmitting = true
      try {
        const res = await API.oauth.complete(provider, {
          flowId,
          callback,
        })
        if (res.status === "complete") {
          this.deviceFlowStep = "success"
          await this.load()
          return
        }
        throw new Error(res.error || "OAuth completion failed")
      } catch (error) {
        const message =
          error instanceof Error ?
            error.message
          : I18n.t("accounts.oauth.error")
        this.showToast(message, "error")
      } finally {
        this.oauthCallbackSubmitting = false
      }
    },

    pollOAuthFlow() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      let pollInterval = (this.oauthFlowData?.interval || 5) * 1000

      const doPoll = async () => {
        if (this.deviceFlowStep !== "pending" || !flowId) {
          return
        }
        try {
          const res = await API.oauth.poll(provider, flowId)
          if (res.status === "complete") {
            this.deviceFlowStep = "success"
            await this.load()
            return
          }
          if (res.status === "error") {
            await this.cancelOAuthFlow()
            this.deviceFlowStep = "input"
            this.oauthFlowData = null
            this.showToast(res.error || I18n.t("accounts.oauth.error"), "error")
            return
          }
          if (res.status === "expired") {
            await this.cancelOAuthFlow()
            this.deviceFlowStep = "input"
            this.oauthFlowData = null
            this.showToast(I18n.t("accounts.oauth.expired"), "error")
            return
          }
          if (res.interval) {
            pollInterval = res.interval * 1000
          }
        } catch {
          // Continue polling
        }
        this.pollTimer = setTimeout(doPoll, pollInterval)
      }

      this.pollTimer = setTimeout(doPoll, pollInterval)
    },

    formatQuotaSummary(account) {
      return QuotaDisplay.formatSummary(account, (key, params) =>
        this.t(key, params),
      )
    },

    async refreshAccountQuota(account) {
      if (!account?.id || account.supportsQuota === false) return
      this.refreshingQuotaId = account.id
      try {
        const result = await API.quota.refreshOne(account.id)
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            quotaInfo: result.quotaInfo ?? this.accounts[idx].quotaInfo,
            quotaState: result.quotaState ?? this.accounts[idx].quotaState,
          }
        }
        this.showToast(I18n.t("accounts.quotaRefreshSuccess"), "success")
      } catch {
        this.showToast(I18n.t("accounts.quotaRefreshError"), "error")
      } finally {
        this.refreshingQuotaId = null
      }
    },

    async toggleEnabled(account) {
      try {
        await API.accounts.update(account.id, { enabled: !account.enabled })
        this.showToast(
          account.enabled ?
            I18n.t("accounts.disableSuccess")
          : I18n.t("accounts.enableSuccess"),
          "success",
        )
        await this.load()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async savePriority(account) {
      const priority = Math.max(0, Math.min(100, account.priority ?? 0))
      try {
        await API.accounts.update(account.id, { priority })
        this.showToast(
          I18n.t("accounts.prioritySuccess") || "Priority updated",
          "success",
        )
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async decreasePriority(account) {
      const newPriority = Math.max(0, (account.priority ?? 0) - 1)
      account.priority = newPriority
      await this.savePriority(account)
    },

    async increasePriority(account) {
      const newPriority = Math.min(100, (account.priority ?? 0) + 1)
      account.priority = newPriority
      await this.savePriority(account)
    },

    async deleteAccount(id) {
      if (!confirm(I18n.t("accounts.confirmDelete"))) return
      try {
        await API.accounts.delete(id)
        this.showToast(I18n.t("accounts.deleteSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("error.delete"), "error")
      }
    },

    async exportAccounts() {
      try {
        const response = await API.accounts.export()
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename = match ? match[1] : "copilot-api-accounts.json"
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(I18n.t("accounts.exportSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    async exportOneAccount(account) {
      try {
        const response = await API.accounts.exportOne(account.id)
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename = match ? match[1] : "copilot-api-account.json"
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(I18n.t("accounts.exportOneSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    openImportModal() {
      this.importFile = null
      this.importSkipDuplicates = true
      this.importMode = "standard"
      this.showImportModal = true
      this.$nextTick(() => {
        if (this.$refs.importFileInput) this.$refs.importFileInput.value = ""
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
        this.showToast(I18n.t("accounts.importNoFile"), "error")
        return
      }
      let parsed
      try {
        const text = await this.importFile.text()
        parsed = JSON.parse(text)
      } catch {
        this.showToast(I18n.t("accounts.importInvalidFile"), "error")
        return
      }
      if (this.importMode === "standard") {
        const accounts = Array.isArray(parsed) ? parsed : parsed.accounts || []
        if (accounts.length === 0) {
          this.showToast(I18n.t("accounts.importInvalidFile"), "error")
          return
        }
      }

      try {
        const result =
          this.importMode === "cpa" ?
            await API.accounts.importCpa({
              records: parsed,
              overwrite: !this.importSkipDuplicates,
            })
          : await API.accounts.import({
              accounts: Array.isArray(parsed) ? parsed : parsed.accounts || [],
              overwrite: !this.importSkipDuplicates,
            })
        let msg = I18n.t("accounts.importSuccess", { count: result.imported })
        if (result.skipped > 0)
          msg += I18n.t("accounts.importSkipped", { count: result.skipped })
        if (result.failed > 0)
          msg += I18n.t("accounts.importFailed", { count: result.failed })
        this.showToast(msg, result.imported > 0 ? "success" : "info")
        this.closeImportModal()
        await this.load()
      } catch (e) {
        this.showToast(e.message || I18n.t("error.create"), "error")
      }
    },

    showToast(msg, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(msg, type)
    },
    t(key, params) {
      // Access parent lang to establish reactive dependency
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },
    getFilteredModels(account) {
      const q = (this.modelSearch[account.id] || "").toLowerCase()
      if (!q) return account.availableModels || []
      return (account.availableModels || []).filter((m) => {
        return (
          (m.id || "").toLowerCase().includes(q)
          || (m.name || "").toLowerCase().includes(q)
          || (m.vendor || "").toLowerCase().includes(q)
        )
      })
    },

    isUniqueSubtitle(subtitle) {
      if (!subtitle) return false
      return (
        (this.accounts || []).filter((a) => a.subtitle === subtitle).length
        === 1
      )
    },
  }
}

// Connections View Component
