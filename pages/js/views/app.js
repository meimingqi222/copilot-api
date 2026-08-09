function adminApp() {
  return {
    currentView: "dashboard",
    validViews: [
      "accounts",
      "connections",
      "model-aliases",
      "dashboard",
      "guard",
      "logs",
      "performance",
      "quotas",
      "usage",
      "users",
    ],
    initialized: false,
    toasts: [],
    lang: I18n.currentLang(),
    sidebarOpen: false,

    resolveHashView(hash) {
      if (hash === "quota" || hash === "quota-usage") {
        return { view: "usage", canonical: "usage" }
      }
      if (hash === "quota-accounts" || hash === "account-quota") {
        return { view: "quotas", canonical: "quotas" }
      }
      if (hash && this.validViews.includes(hash)) {
        return { view: hash, canonical: hash }
      }
      return null
    },

    applyHashView(hash) {
      const resolved = this.resolveHashView(hash)
      if (!resolved) return
      this.currentView = resolved.view
      if (globalThis.location.hash.slice(1) !== resolved.canonical) {
        globalThis.location.hash = resolved.canonical
      }
    },

    async init() {
      // Restore view from URL hash or default to dashboard
      const hash = globalThis.location.hash.slice(1)
      this.applyHashView(hash)

      await this.checkAuth()
      this.initialized = true
      lucide.createIcons()
      // Refresh quotas in background after login
      this.refreshQuotaInBackground()

      // Listen for hash changes
      globalThis.addEventListener("hashchange", () => {
        this.applyHashView(globalThis.location.hash.slice(1))
      })

      // Update hash when currentView changes
      this.$watch("currentView", (view) => {
        if (globalThis.location.hash.slice(1) !== view) {
          globalThis.location.hash = view
        }
      })
    },

    async refreshQuotaInBackground() {
      try {
        // Silently refresh quotas from GitHub Copilot API
        await API.quota.refresh()
      } catch (e) {
        // Silent fail - quotas will be loaded from cache on quota view
        console.warn("Background quota refresh failed:", e)
      }
    },

    async checkAuth() {
      try {
        const isAuth = await API.auth.check()
        if (!isAuth) globalThis.location.href = "/admin/login"
      } catch {
        globalThis.location.href = "/admin/login"
      }
    },

    // i18n helpers
    t(key, params = {}) {
      // Access this.lang to establish reactive dependency
      void this.lang
      return I18n.t(key, params)
    },

    get currentLang() {
      return this.lang
    },

    setLang(lang) {
      I18n.setLang(lang)
      this.lang = lang
      this.$nextTick(() => lucide.createIcons())
    },

    formatTime(ts) {
      if (!ts) return "-"
      return new Date(ts).toLocaleString(
        this.currentLang === "zh" ? "zh-CN" : "en-US",
      )
    },

    get navItems() {
      return [
        {
          id: "dashboard",
          icon: "layout-dashboard",
          label: this.t("nav.dashboard"),
        },
        { id: "users", icon: "key", label: this.t("nav.users") },
        { id: "accounts", icon: "users", label: this.t("nav.accounts") },
        { id: "connections", icon: "plug", label: this.t("nav.connections") },
        {
          id: "model-aliases",
          icon: "shuffle",
          label: this.t("nav.modelAliases"),
        },
        { id: "usage", icon: "bar-chart-3", label: this.t("nav.usage") },
        { id: "quotas", icon: "battery-charging", label: this.t("nav.quotas") },
        { id: "performance", icon: "gauge", label: this.t("nav.performance") },
        { id: "guard", icon: "shield", label: this.t("nav.guard") },
        { id: "logs", icon: "scroll-text", label: this.t("nav.logs") },
      ]
    },

    // Toast notifications
    showToast(message, type = "info", duration = 5000) {
      const id = Date.now() + Math.random()
      this.toasts.push({ id, message, type })
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, duration)
    },

    async logout() {
      await API.auth.logout()
      globalThis.location.href = "/admin/login"
    },
  }
}

// Dashboard View Component
