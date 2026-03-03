// API Client
const API = {
  baseUrl: "/admin/api",

  // Helper: Make request
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`
    const config = {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    }

    if (config.body && typeof config.body === "object") {
      config.body = JSON.stringify(config.body)
    }

    const response = await fetch(url, config)

    if (response.status === 401) {
      globalThis.location.href = "/admin/login"
      throw new Error("Unauthorized")
    }

    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || `HTTP ${response.status}`)
    }

    const contentType = response.headers.get("content-type")
    if (contentType && contentType.includes("application/json")) {
      return await response.json()
    }
    return await response.text()
  },

  // Dashboard
  dashboard: {
    get: () => API.request("/dashboard"),
  },

  // Users
  users: {
    list: () => API.request("/users"),
    create: (data) => API.request("/users", { method: "POST", body: data }),
    update: (id, data) =>
      API.request(`/users/${id}`, { method: "PUT", body: data }),
    delete: (id) => API.request(`/users/${id}`, { method: "DELETE" }),
    resetKey: (id) => API.request(`/users/${id}/reset-key`, { method: "POST" }),
  },

  // Accounts
  accounts: {
    list: () => API.request("/accounts"),
    create: (label) =>
      API.request("/accounts", { method: "POST", body: { label } }),
    delete: (id) => API.request(`/accounts/${id}`, { method: "DELETE" }),
    poll: (deviceCode) =>
      API.request(`/accounts/poll/${deviceCode}`, { method: "POST" }),
    refresh: (id) => API.request(`/accounts/${id}/refresh`, { method: "POST" }),
  },

  // Quota
  quota: {
    get: () => API.request("/quota"),
    refresh: () => API.request("/quota/refresh", { method: "POST" }),
  },

  // Logs
  logs: {
    get: (filters = {}) => {
      const params = new URLSearchParams()
      if (filters.level) params.set("level", filters.level)
      if (filters.search) params.set("search", filters.search)
      if (filters.limit) params.set("limit", filters.limit.toString())
      if (filters.offset !== undefined)
        params.set("offset", filters.offset.toString())

      const query = params.toString()
      return API.request(`/logs${query ? "?" + query : ""}`)
    },
    getRecent: (limit = 10) => API.request(`/logs?limit=${limit}`),
  },

  // Auth
  auth: {
    check: async () => {
      try {
        await API.request("/dashboard")
        return true
      } catch {
        return false
      }
    },
    logout: () => fetch("/admin/logout", { method: "POST" }),
  },
}

// API is already a global variable
