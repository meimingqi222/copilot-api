function usersView() {
  return {
    ...ViewHelpers,
    loading: false,
    users: [],
    models: [],
    showCreateModal: false,
    showModelsModal: false,
    showKeyModal: false,
    showEditModal: false,
    newApiKey: "",
    selectedUser: null,
    selectedModels: [],
    editingUser: null,
    newUser: { username: "", role: "user", quotaLimit: "0", allowedModels: [] },
    modelSearch: "",
    modelSearchEdit: "",

    get filteredModels() {
      const q = (this.modelSearch || "").toLowerCase()
      if (!q) return this.models
      return this.models.filter(
        (m) =>
          m.id.toLowerCase().includes(q)
          || (m.name || "").toLowerCase().includes(q),
      )
    },

    get filteredModelsEdit() {
      const q = (this.modelSearchEdit || "").toLowerCase()
      if (!q) return this.models
      return this.models.filter(
        (m) =>
          m.id.toLowerCase().includes(q)
          || (m.name || "").toLowerCase().includes(q),
      )
    },

    async load() {
      this.loading = true
      try {
        const [usersData, modelsData] = await Promise.all([
          API.users.list(),
          API.users.models(),
        ])
        this.users = usersData.users || []
        this.models = modelsData.models || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    openCreateModal() {
      this.newUser = {
        username: "",
        role: "user",
        quotaLimit: "0",
        allowedModels: [],
      }
      this.showCreateModal = true
    },

    async createUser() {
      try {
        const res = await API.users.create({
          ...this.newUser,
          quotaLimit: this.parseQuotaToNumber(this.newUser.quotaLimit),
        })
        this.showCreateModal = false
        this.newApiKey = res.apiKey
        this.showKeyModal = true
        this.showToast(I18n.t("users.createSuccess"), "success")
        await this.load()
        this.$nextTick(() => lucide.createIcons())
      } catch {
        this.showToast(I18n.t("error.create"), "error")
      }
    },

    async toggleEnabled(user) {
      try {
        await API.users.update(user.id, { enabled: !user.enabled })
        this.showToast(I18n.t("users.updateSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    openModelsModal(user) {
      this.selectedUser = user
      this.selectedModels = [...(user.allowedModels || [])]
      this.showModelsModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    isModelSelected(modelId) {
      return this.selectedModels.includes(modelId)
    },

    toggleModel(modelId) {
      if (this.isModelSelected(modelId)) {
        this.selectedModels = this.selectedModels.filter((id) => id !== modelId)
        return
      }
      this.selectedModels = [...this.selectedModels, modelId]
    },

    async saveModels() {
      if (!this.selectedUser) return
      try {
        await API.users.update(this.selectedUser.id, {
          allowedModels: this.selectedModels,
        })
        this.showModelsModal = false
        this.showToast(I18n.t("users.updateSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    modelAccessText(user) {
      const count = user.allowedModels?.length || 0
      return count === 0 ? I18n.t("users.models.unrestricted") : String(count)
    },

    async resetKey(user) {
      if (!confirm(I18n.t("users.confirmReset"))) return
      try {
        const res = await API.users.resetKey(user.id)
        this.newApiKey = res.apiKey
        this.showKeyModal = true
        this.showToast(I18n.t("users.resetSuccess"), "success")
        this.$nextTick(() => lucide.createIcons())
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async resetTokens(user) {
      if (!confirm(I18n.t("users.confirmResetTokens"))) return
      try {
        await API.users.resetTokens(user.id)
        user.usedTokens = 0
        this.showToast(I18n.t("users.resetTokensSuccess"), "success")
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async deleteUser(user) {
      if (!confirm(I18n.t("users.confirmDelete"))) return
      try {
        await API.users.delete(user.id)
        this.showToast(I18n.t("users.deleteSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("error.delete"), "error")
      }
    },

    openEditModal(user) {
      this.editingUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        quotaLimit: this.formatQuotaToString(user.quotaLimit),
        allowedModels: [...(user.allowedModels || [])],
      }
      this.showEditModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    toggleEditModel(modelId) {
      if (!this.editingUser) return
      const idx = this.editingUser.allowedModels.indexOf(modelId)
      this.editingUser.allowedModels =
        idx !== -1 ?
          this.editingUser.allowedModels.filter((id) => id !== modelId)
        : [...this.editingUser.allowedModels, modelId]
    },

    async saveEditUser() {
      if (!this.editingUser) return
      try {
        await API.users.update(this.editingUser.id, {
          username: this.editingUser.username.trim(),
          role: this.editingUser.role,
          quotaLimit: this.parseQuotaToNumber(this.editingUser.quotaLimit),
          allowedModels: this.editingUser.allowedModels,
        })
        this.showEditModal = false
        this.showToast(I18n.t("users.updateSuccess"), "success")
        await this.load()
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async copyKey() {
      try {
        await navigator.clipboard.writeText(this.newApiKey)
        this.showToast(I18n.t("copySuccess"), "success")
      } catch {
        // Fallback
        const el = document.createElement("textarea")
        el.value = this.newApiKey
        document.body.append(el)
        el.select()
        document.execCommand("copy")
        el.remove()
        this.showToast(I18n.t("copySuccess"), "success")
      }
    },

    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleString()
    },
    parseQuotaToNumber(val) {
      if (val === undefined || val === null || val === "") return 0
      const str = String(val).trim().toLowerCase()
      if (str === "0") return 0
      const match = str.match(/^(\d+(?:\.\d+)?)([kmb]?)$/)
      if (!match) return Number.parseInt(str, 10) || 0
      const num = Number.parseFloat(match[1])
      const suffix = match[2]
      if (suffix === "k") return Math.round(num * 1000)
      if (suffix === "m") return Math.round(num * 1_000_000)
      if (suffix === "b") return Math.round(num * 1_000_000_000)
      return Math.round(num)
    },

    formatQuotaToString(val) {
      const num = Number(val || 0)
      if (num === 0) return "0"
      if (num >= 1_000_000_000 && num % 1_000_000_000 === 0)
        return num / 1_000_000_000 + "B"
      if (num >= 1_000_000 && num % 1_000_000 === 0)
        return num / 1_000_000 + "M"
      if (num >= 1000 && num % 1000 === 0) return num / 1000 + "K"
      return String(num)
    },
  }
}

// Accounts View Component
