function adminApp() {
  return {
    currentView: "dashboard",
    validViews: [
      "accounts",
      "connections",
      "model-aliases",
      "routing-groups",
      "dashboard",
      "guard",
      "logs",
      "performance",
      "quotas",
      "traces",
      "usage",
      "users",
      "system-config",
    ],
    initialized: false,
    quotaDisplayMode: "remaining",
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
      globalThis.addEventListener("quota-display-mode", (event) => {
        if (["remaining", "used"].includes(event.detail)) {
          this.quotaDisplayMode = event.detail
        }
      })
      await this.loadQuotaDisplayMode()
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
        if (view === "quotas" || view === "traces") {
          void this.loadQuotaDisplayMode()
        }
        if (globalThis.location.hash.slice(1) !== view) {
          globalThis.location.hash = view
        }
      })
    },

    async loadQuotaDisplayMode() {
      try {
        const data = await API.request("/system-config")
        this.quotaDisplayMode = data.settings.quotaDisplayMode || "remaining"
      } catch (error) {
        console.warn("Failed to load quota display preference:", error)
      }
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

    get navGroups() {
      return [
        {
          id: "overview",
          items: [{ id: "dashboard", icon: "layout-dashboard" }],
        },
        {
          id: "upstream",
          items: [
            { id: "accounts", icon: "users" },
            { id: "connections", icon: "plug" },
            { id: "quotas", icon: "battery-charging" },
          ],
        },
        {
          id: "models",
          items: [
            { id: "model-aliases", icon: "shuffle", labelKey: "modelAliases" },
            {
              id: "routing-groups",
              icon: "git-branch",
              labelKey: "routingGroups",
            },
          ],
        },
        {
          id: "monitoring",
          items: [
            { id: "usage", icon: "bar-chart-3" },
            { id: "performance", icon: "gauge" },
            { id: "traces", icon: "route" },
            { id: "logs", icon: "scroll-text" },
          ],
        },
        {
          id: "access",
          items: [
            { id: "users", icon: "key" },
            { id: "guard", icon: "shield" },
            { id: "system-config", icon: "settings" },
          ],
        },
      ].map((group) => ({
        ...group,
        label: this.t(`nav.group.${group.id}`),
        items: group.items.map((item) => ({
          ...item,
          label: this.t(`nav.${item.labelKey || item.id}`),
        })),
      }))
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
