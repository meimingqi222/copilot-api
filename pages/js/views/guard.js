function guardView() {
  return {
    ...ViewHelpers,
    loading: false,
    tab: "ip",
    search: "",
    filter: "all",
    clients: [],
    blacklist: [],
    whitelistBuiltin: [],
    whitelistCustom: [],
    newWhitelistPattern: "",
    blockModalOpen: false,
    blockSubmitting: false,
    blockForm: {
      target: null,
      duration: "1h",
      reason: "",
    },

    get overview() {
      const clients = this.clients || []
      return {
        total: clients.length,
        suspicious: clients.filter((client) => client.suspicious).length,
        blocked: clients.filter((client) => client.blocked).length,
        recommended: clients.filter(
          (client) =>
            !client.blocked && client.recommendedAction === "temporary_block",
        ).length,
      }
    },

    get filteredClients() {
      const query = this.search.trim().toLowerCase()
      return (this.clients || []).filter((client) => {
        if (this.filter === "suspicious" && !client.suspicious) return false
        if (this.filter === "blocked" && !client.blocked) return false
        if (
          this.filter === "recommended"
          && client.recommendedAction !== "temporary_block"
        ) {
          return false
        }

        if (!query) return true

        const searchable = [
          client.key,
          ...(client.usernames || []),
          ...(client.topPaths || []).map((path) => path.path),
          ...(client.suspiciousReasons || []).map((reason) =>
            this.t("guard.reason." + reason),
          ),
        ]
          .join(" ")
          .toLowerCase()

        return searchable.includes(query)
      })
    },

    async load() {
      if (this.tab === "blacklist") {
        await this.loadBlacklist()
        return
      }
      if (this.tab === "whitelist") {
        await this.loadWhitelist()
        return
      }
      this.loading = true
      try {
        const data = await API.guard.clients(this.tab)
        this.clients = data.clients || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    async loadBlacklist() {
      this.loading = true
      try {
        const data = await API.guard.blacklist()
        this.blacklist = data.blacklist || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
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

      let expiresAt
      if (this.blockForm.duration === "1h") {
        expiresAt = Date.now() + 60 * 60 * 1000
      } else if (this.blockForm.duration === "24h") {
        expiresAt = Date.now() + 24 * 60 * 60 * 1000
      }

      this.blockSubmitting = true
      try {
        await API.guard.block({
          value: this.blockForm.target.key,
          type: this.tab,
          reason: this.blockForm.reason.trim() || undefined,
          expiresAt,
        })
        this.showToast(I18n.t("guard.blockSuccess"), "success")
        this.closeBlockModal()
        await this.load()
      } catch (e) {
        const errorMsg = e?.message || I18n.t("error.update")
        this.showToast(errorMsg, "error")
      } finally {
        this.blockSubmitting = false
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
        const errorMsg = e?.error || I18n.t("error.update")
        this.showToast(errorMsg, "error")
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

// Logs View Component
