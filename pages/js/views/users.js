function usersView() {
  return {
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
    newUser: { username: "", role: "user", quotaLimit: 0, allowedModels: [] },

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
        quotaLimit: 0,
        allowedModels: [],
      }
      this.showCreateModal = true
    },

    async createUser() {
      try {
        const res = await API.users.create(this.newUser)
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
        quotaLimit: user.quotaLimit ?? 0,
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
          quotaLimit: this.editingUser.quotaLimit ?? 0,
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

    showToast(msg, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(msg, type)
    },
    formatTime(ts) {
      if (!ts) return "-"
      const app = document.querySelector("[x-data^=adminApp]")
      return app ?
          Alpine.$data(app).formatTime(ts)
        : new Date(ts).toLocaleString()
    },
    t(key, params) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },
    formatTokens(tokens) {
      const numericTokens = Number(tokens || 0)
      if (numericTokens === 0) return "0"
      if (numericTokens >= 1000000) {
        return (numericTokens / 1000000).toFixed(1) + "M"
      }
      if (numericTokens >= 1000) {
        return (numericTokens / 1000).toFixed(1) + "K"
      }
      return numericTokens.toString()
    },
  }
}

// Accounts View Component
