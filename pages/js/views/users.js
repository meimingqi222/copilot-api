function usersView() {
  return {
    loading: false,
    users: [],
    showCreateModal: false,
    showKeyModal: false,
    newApiKey: "",
    newUser: { username: "", role: "user", quotaLimit: 0 },

    async load() {
      this.loading = true
      try {
        const data = await API.users.list()
        this.users = data.users || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    openCreateModal() {
      this.newUser = { username: "", role: "user", quotaLimit: 0 }
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
  }
}

// Accounts View Component
