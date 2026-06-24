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
    models: () => API.request("/users/models"),
    create: (data) => API.request("/users", { method: "POST", body: data }),
    update: (id, data) =>
      API.request(`/users/${id}`, { method: "PUT", body: data }),
    delete: (id) => API.request(`/users/${id}`, { method: "DELETE" }),
    resetKey: (id) => API.request(`/users/${id}/reset-key`, { method: "POST" }),
    resetTokens: (id) =>
      API.request(`/users/${id}/reset-tokens`, { method: "POST" }),
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
    export: async () => {
      const response = await fetch(`${API.baseUrl}/accounts/export`)
      if (response.status === 401 || response.status === 403) {
        globalThis.location.href = "/admin/login"
        throw new Error("Unauthorized")
      }
      if (!response.ok) {
        const errorText = await response.text()
        throw API.extractErrorMessage(errorText, response.status)
      }
      return response
    },
    exportOne: async (id) => {
      const response = await fetch(`${API.baseUrl}/accounts/${id}/export`)
      if (response.status === 401 || response.status === 403) {
        globalThis.location.href = "/admin/login"
        throw new Error("Unauthorized")
      }
      if (!response.ok) {
        const errorText = await response.text()
        throw API.extractErrorMessage(errorText, response.status)
      }
      return response
    },
    import: (data) =>
      API.request("/accounts/import", { method: "POST", body: data }),
    importCpa: (data) =>
      API.request("/accounts/import-cpa", { method: "POST", body: data }),
  },

  providers: {
    list: () => API.request("/providers"),
  },

  providerConnections: {
    list: () => API.request("/provider-connections"),
    get: (id) => API.request(`/provider-connections/${id}`),
    create: (data) =>
      API.request("/provider-connections", { method: "POST", body: data }),
    update: (id, data) =>
      API.request(`/provider-connections/${id}`, {
        method: "PUT",
        body: data,
      }),
    delete: (id) =>
      API.request(`/provider-connections/${id}`, { method: "DELETE" }),
    refreshModels: (id) =>
      API.request(`/provider-connections/${id}/refresh-models`, {
        method: "POST",
      }),
    addCredential: (connectionId, data) =>
      API.request(`/provider-connections/${connectionId}/credentials`, {
        method: "POST",
        body: data,
      }),
    updateCredential: (connectionId, credentialId, data) =>
      API.request(
        `/provider-connections/${connectionId}/credentials/${credentialId}`,
        { method: "PUT", body: data },
      ),
    deleteCredential: (connectionId, credentialId) =>
      API.request(
        `/provider-connections/${connectionId}/credentials/${credentialId}`,
        { method: "DELETE" },
      ),
    enableCredential: (connectionId, credentialId) =>
      API.request(
        `/provider-connections/${connectionId}/credentials/${credentialId}/enable`,
        { method: "POST" },
      ),
    disableCredential: (connectionId, credentialId) =>
      API.request(
        `/provider-connections/${connectionId}/credentials/${credentialId}/disable`,
        { method: "POST" },
      ),
    resetCredentialStatus: (connectionId, credentialId) =>
      API.request(
        `/provider-connections/${connectionId}/credentials/${credentialId}/reset-status`,
        { method: "POST" },
      ),
    testConnection: (id, credentialId) =>
      API.request(`/provider-connections/${id}/test`, {
        method: "POST",
        body: credentialId ? { credentialId } : undefined,
      }),
    addModel: (id, data) =>
      API.request(`/provider-connections/${id}/models`, {
        method: "POST",
        body: data,
      }),
    updateModel: (id, publicId, data) =>
      API.request(
        `/provider-connections/${id}/models/${encodeURIComponent(publicId)}`,
        { method: "PUT", body: data },
      ),
    deleteModel: (id, publicId) =>
      API.request(
        `/provider-connections/${id}/models/${encodeURIComponent(publicId)}`,
        { method: "DELETE" },
      ),
    revealCredential: (id, credId) =>
      API.request(`/provider-connections/${id}/credentials/${credId}/value`),
  },

  accountFlows: {
    poll: (flowId) =>
      API.request(`/account-flows/${flowId}/poll`, { method: "POST" }),
  },

  // Quota
  quota: {
    get: () => API.request("/quota"),
    refresh: () => API.request("/quota/refresh", { method: "POST" }),
    refreshOne: (id) => API.request(`/quota/${id}/refresh`, { method: "POST" }),
    resetOne: (id) => API.request(`/quota/${id}/reset`, { method: "POST" }),
  },

  oauth: {
    start: (provider, data = {}) =>
      API.request(`/oauth/${provider}/start`, { method: "POST", body: data }),
    poll: (provider, flowId) =>
      API.request(`/oauth/${provider}/poll/${flowId}`),
    complete: (provider, data) =>
      API.request(`/oauth/${provider}/complete`, {
        method: "POST",
        body: data,
      }),
    cancel: (provider, data) =>
      API.request(`/oauth/${provider}/cancel`, {
        method: "POST",
        body: data,
      }),
  },

  // Usage Statistics
  usage: {
    summary: (params = {}) => {
      const opts = typeof params === "string" ? { range: params } : params
      const qs = new URLSearchParams()
      if (opts.range) qs.set("range", opts.range)
      if (opts.month) qs.set("month", opts.month)
      if (opts.startDate) qs.set("startDate", opts.startDate)
      if (opts.endDate) qs.set("endDate", opts.endDate)
      const query = qs.toString()
      return API.request(`/usage/summary${query ? "?" + query : ""}`)
    },
    performance: (params = {}) => {
      const qs = new URLSearchParams()
      if (params.range) qs.set("range", params.range)
      if (params.month) qs.set("month", params.month)
      if (params.startDate) qs.set("startDate", params.startDate)
      if (params.endDate) qs.set("endDate", params.endDate)
      const query = qs.toString()
      return API.request(`/usage/performance${query ? "?" + query : ""}`)
    },
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
