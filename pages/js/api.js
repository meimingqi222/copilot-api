// API Client
const API = {
  baseUrl: "/admin/api",

  // Helper: Extract error message from response
  extractErrorMessage(errorText, responseStatus) {
    let errorData = { error: errorText || `HTTP ${responseStatus}` }
    try {
      errorData = JSON.parse(errorText)
    } catch {
      // Not JSON, use raw text
    }

    // Extract error message with fallbacks
    let message = errorText
    switch ("string") {
      case typeof errorData.error: {
        message = errorData.error

        break
      }
      case typeof errorData.error?.message: {
        message = errorData.error.message

        break
      }
      case typeof errorData.message: {
        message = errorData.message

        break
      }
      // No default
    }

    const error = new Error(message || `HTTP ${responseStatus}`)
    error.data = errorData
    return error
  },

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

    if (response.status === 401 || response.status === 403) {
      globalThis.location.href = "/admin/login"
      throw new Error("Unauthorized")
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw this.extractErrorMessage(errorText, response.status)
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
    create: (data) => API.request("/accounts", { method: "POST", body: data }),
    update: (id, data) =>
      API.request(`/accounts/${id}`, { method: "PUT", body: data }),
    delete: (id) => API.request(`/accounts/${id}`, { method: "DELETE" }),
    poll: (deviceCode) =>
      API.request(`/accounts/poll/${deviceCode}`, { method: "POST" }),
    refresh: (id) => API.request(`/accounts/${id}/refresh`, { method: "POST" }),
    activate: (id) =>
      API.request(`/accounts/${id}/activate`, { method: "POST" }),
  },

  providers: {
    list: () => API.request("/providers"),
  },

  accountFlows: {
    poll: (flowId) =>
      API.request(`/account-flows/${flowId}/poll`, { method: "POST" }),
  },

  // Quota
  quota: {
    get: () => API.request("/quota"),
    refresh: () => API.request("/quota/refresh", { method: "POST" }),
  },

  // Usage Statistics
  usage: {
    summary: (range = "today") => API.request(`/usage/summary?range=${range}`),
    getPricing: () => API.request("/usage/pricing"),
    updatePricing: (model, pricing) =>
      API.request(`/usage/pricing/${model}`, { method: "PUT", body: pricing }),
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

  // Guard
  guard: {
    clients: (type = "ip") => API.request(`/guard/clients?type=${type}`),
    blacklist: () => API.request("/guard/blacklist"),
    block: (data) =>
      API.request("/guard/blacklist", { method: "POST", body: data }),
    unblock: (data) =>
      API.request("/guard/blacklist", { method: "DELETE", body: data }),
    uaWhitelist: () => API.request("/guard/ua-whitelist"),
    addUaWhitelist: (pattern) =>
      API.request("/guard/ua-whitelist", { method: "POST", body: { pattern } }),
    removeUaWhitelist: (pattern) =>
      API.request("/guard/ua-whitelist", {
        method: "DELETE",
        body: { pattern },
      }),
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
