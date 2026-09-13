function guardView() {
  return {
    ...ViewHelpers,
    loading: false,
    tab: "blocks",
    search: "",
    filter: "all",
    principals: [],
    clients: [],
    clientType: "ip",
    tempBlocks: [],
    overviewData: null,
    blacklist: [],
    whitelistBuiltin: [],
    whitelistCustom: [],
    newWhitelistPattern: "",
    guardConfig: null,
    guardDefaults: null,
    configDraft: {},
    configSaving: false,
    blockModalOpen: false,
    blockSubmitting: false,
    blockForm: {
      target: null,
      duration: "1h",
      reason: "",
    },

    get overview() {
      if (this.overviewData) return this.overviewData
      const principals = this.principals || []
      return {
        total: principals.length,
        suspicious: principals.filter((p) => p.suspicious).length,
        blocked: principals.filter((p) => p.tempBlocked || p.blacklisted)
          .length,
        tempBlocked: (this.tempBlocks || []).length,
        recommended: principals.filter(
          (p) =>
            !p.tempBlocked
            && !p.blacklisted
            && p.recommendedAction === "temporary_block",
        ).length,
      }
    },

    get filteredPrincipals() {
      const query = this.search.trim().toLowerCase()
      return (this.principals || []).filter((p) => {
        if (this.filter === "suspicious" && !p.suspicious) return false
        if (this.filter === "blocked" && !p.tempBlocked && !p.blacklisted) {
          return false
        }
        if (this.filter === "tempblocked" && !p.tempBlocked) return false
        if (
          this.filter === "recommended"
          && (p.tempBlocked
            || p.blacklisted
            || p.recommendedAction !== "temporary_block")
        ) {
          return false
        }
        if (!query) return true
        const searchable = [
          p.principal,
          p.clientIp,
          p.userAgent,
          p.username,
          p.lastModel,
          p.lastPath,
          ...(p.reasons || []).map((r) => this.t("guard.reason." + r)),
          ...(p.tempBlock?.reason ? [p.tempBlock.reason] : []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        return searchable.includes(query)
      })
    },

    get filteredTempBlocks() {
      const query = this.search.trim().toLowerCase()
      if (!query) return this.tempBlocks || []
      return (this.tempBlocks || []).filter((b) =>
        [b.principal, b.clientIp, b.userAgent, b.username, b.reason, b.model]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    },

    async load() {
      if (this.tab === "blocks") {
        await Promise.all([this.loadTempBlocks(), this.loadOverview()])
        await this.loadBlacklist(true)
        return
      }
      if (this.tab === "clients") {
        await this.loadPrincipals()
        return
      }
      if (this.tab === "policy") {
        await Promise.all([this.loadWhitelist(), this.loadGuardConfig()])
        return
      }
    },

    async loadTempBlocks() {
      this.loading = true
      try {
        const data = await API.guard.tempBlocks()
        this.tempBlocks = data.blocks || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadOverview() {
      try {
        this.overviewData = await API.guard.overview()
      } catch {
        this.overviewData = null
      }
    },

    async loadPrincipals() {
      this.loading = true
      try {
        const data = await API.guard.principals(500)
        this.principals = data.principals || []
        // Keep legacy clients in sync for the type toggle.
        this.clients = this.principals
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadBlacklist(silent) {
      if (!silent) this.loading = true
      try {
        const data = await API.guard.blacklist()
        this.blacklist = data.blacklist || []
      } catch {
        if (!silent) this.showToast(I18n.t("error.load"), "error")
      } finally {
        if (!silent) this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadWhitelist() {
      this.loading = true
      try {
        const data = await API.guard.uaWhitelist()
        this.whitelistBuiltin = data.builtin || []
        this.whitelistCustom = data.custom || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadGuardConfig() {
      try {
        const data = await API.guard.guardConfig()
        this.guardConfig = data.config
        this.guardDefaults = data.defaults
        this.configDraft = { ...data.config }
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async saveGuardConfig() {
      const patch = {}
      for (const [k, v] of Object.entries(this.configDraft || {})) {
        if (
          JSON.stringify(v)
          !== JSON.stringify(this.guardConfig ? this.guardConfig[k] : undefined)
        ) {
          patch[k] = v
        }
      }
      if (Object.keys(patch).length === 0) return
      this.configSaving = true
      try {
        const data = await API.guard.updateGuardConfig(patch)
        this.guardConfig = data.config
        this.configDraft = { ...data.config }
        this.showToast(I18n.t("guard.configSaved"), "success")
      } catch (e) {
        this.showToast(e?.message || I18n.t("error.update"), "error")
      } finally {
        this.configSaving = false
      }
    },

    resetGuardConfigDraft() {
      this.configDraft = { ...this.guardConfig }
    },

    openBlockModal(client) {
      this.blockForm = {
        target: client,
        duration:
          client?.recommendedAction === "temporary_block" ? "24h" : "1h",
        reason: "",
      }
      this.blockModalOpen = true
      this.$nextTick(() => lucide.createIcons())
    },

    closeBlockModal() {
      this.blockModalOpen = false
      this.blockSubmitting = false
      this.blockForm = { target: null, duration: "1h", reason: "" }
    },

    async submitBlock() {
      if (!this.blockForm.target) return
      const t = this.blockForm.target
      const key = t.principal || t.key
      const isPrincipal =
        typeof key === "string"
        && (key.startsWith("user:")
          || key.startsWith("key:")
          || key.startsWith("ip:"))

      this.blockSubmitting = true
      try {
        if (isPrincipal) {
          const durations = {
            "30m": 30 * 60 * 1000,
            "1h": 60 * 60 * 1000,
            "24h": 24 * 60 * 60 * 1000,
            permanent: 7 * 24 * 60 * 60 * 1000,
          }
          const durationMs = durations[this.blockForm.duration]
          await API.guard.blockPrincipal({
            principal: key,
            durationMs,
            reason: this.blockForm.reason.trim() || undefined,
          })
        } else {
          let expiresAt
          if (this.blockForm.duration === "1h") {
            expiresAt = Date.now() + 60 * 60 * 1000
          } else if (this.blockForm.duration === "24h") {
            expiresAt = Date.now() + 24 * 60 * 60 * 1000
          }
          const rawType = t.type || this.clientType
          await API.guard.block({
            value: key,
            type: rawType === "ua" ? "ua" : "ip",
            reason: this.blockForm.reason.trim() || undefined,
            expiresAt,
          })
        }
        this.showToast(I18n.t("guard.blockSuccess"), "success")
        this.closeBlockModal()
        await this.load()
      } catch (e) {
        this.showToast(e?.message || I18n.t("error.update"), "error")
      } finally {
        this.blockSubmitting = false
      }
    },

    async unblockTemp(principal) {
      if (!confirm(I18n.t("guard.confirmUnblock"))) return
      try {
        await API.guard.unblockPrincipal(principal)
        this.showToast(I18n.t("guard.unblockSuccess"), "success")
        await Promise.all([this.loadTempBlocks(), this.loadPrincipals()])
        await this.loadOverview()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async addWhitelistPattern() {
      const pattern = this.newWhitelistPattern.trim()
      if (!pattern) return
      try {
        await API.guard.addUaWhitelist(pattern)
        this.newWhitelistPattern = ""
        this.showToast(I18n.t("guard.whitelistAdded"), "success")
        await this.loadWhitelist()
      } catch (e) {
        this.showToast(e?.error || I18n.t("error.update"), "error")
      }
    },

    async removeWhitelistPattern(pattern) {
      if (!confirm(I18n.t("guard.confirmRemoveWhitelist"))) return
      try {
        await API.guard.removeUaWhitelist(pattern)
        this.showToast(I18n.t("guard.whitelistRemoved"), "success")
        await this.loadWhitelist()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async unblockEntry(entry) {
      if (!confirm(I18n.t("guard.confirmUnblock"))) return
      try {
        await API.guard.unblock({ value: entry.value, type: entry.type })
        this.showToast(I18n.t("guard.unblockSuccess"), "success")
        await this.loadBlacklist()
        await this.loadOverview()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    riskBadgeClass(level) {
      const map = {
        low: "badge-success",
        medium: "badge-warning",
        high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
        critical: "badge-danger",
      }
      return map[level] || "badge-info"
    },

    signalBadgeClass(reason) {
      const map = {
        premium_abuse:
          "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
        auth_failures:
          "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
        path_scanning:
          "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        burst_traffic:
          "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        high_error_rate:
          "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        high_frequency:
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        no_auth:
          "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
        unknown_ua:
          "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
      }
      return map[reason] || "badge-info"
    },

    formatPercent(value) {
      return `${Math.round((Number(value) || 0) * 100)}%`
    },

    formatExpiry(ts) {
      if (!ts) return this.t("guard.never")
      if (ts <= Date.now()) return this.t("guard.expired")
      return `${this.formatTime(ts)} · ${this.formatRelativeDuration(ts - Date.now())}`
    },

    formatRelativeDuration(ms) {
      const minutes = Math.max(Math.round(ms / 60000), 1)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      const days = Math.round(hours / 24)
      return `${days}d`
    },

    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleString()
    },
  }
}
