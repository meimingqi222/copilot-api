const MANUAL_OAUTH_CALLBACK_PROVIDERS = new Set([
  "claude",
  "codex",
  "xai",
  "antigravity",
])

function accountsView() {
  return {
    ...ViewHelpers,
    loading: false,
    accounts: [],
    providers: [],
    showAddModal: false,
    showImportModal: false,
    /** @type {Array<File>} selected import files (CPA supports multi-select) */
    importFiles: [],
    importSkipDuplicates: true,
    importMode: "standard",
    defaultNewAccount() {
      return {
        label: "",
        provider: "copilot",
        credentials: {},
        settings: {},
      }
    },
    newAccount: {
      label: "",
      provider: "copilot",
      credentials: {},
      settings: {},
    },
    deviceFlowStep: "input",
    deviceFlowData: null,
    oauthFlowData: null,
    oauthCallbackInput: "",
    oauthCallbackSubmitting: false,
    pollTimer: null,
    refreshingQuotaId: null,
    /** 原地重认证目标账号（null = 新建账号流程） */
    reauthAccount: null,
    mimoCookieInput: "",
    codebuddyJsonInput: "",
    lobsteraiJsonInput: "",
    lobsteraiDbLoading: false,

    parseMimoCookie() {
      const str = this.mimoCookieInput
      if (!str) return
      const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/g
      let m
      while ((m = re.exec(str)) !== null) {
        const val = m[2] ?? m[3] ?? m[4] ?? ""
        switch (m[1]) {
          case "serviceToken": {
            this.setAccountFieldValue(
              { key: "serviceToken", type: "secret" },
              val.trim(),
            )
            break
          }
          case "xiaomichatbot_ph": {
            this.setAccountFieldValue(
              { key: "xiaomichatbotPh", type: "secret" },
              val.trim(),
            )
            break
          }
          case "userId": {
            this.setAccountFieldValue(
              { key: "userId", type: "text" },
              val.trim(),
            )
            break
          }
          default: {
            break
          }
        }
      }
    },

    /** 解析 CodeBuddy auth JSON，自动填充 label / accessToken / refreshToken。 */
    parseCodebuddyJson() {
      const str = this.codebuddyJsonInput.trim()
      if (!str) return
      try {
        const obj = JSON.parse(str)
        // 支持多种格式：
        //   { account: { nickname }, auth: { accessToken, refreshToken } }  （CLI auth 文件完整结构）
        //   { accessToken, refreshToken }            （auth 子对象）
        //   { accessToken: "..." }                    （只含 accessToken）
        const auth = obj.auth ?? obj
        if (typeof auth.accessToken === "string" && auth.accessToken) {
          this.setAccountFieldValue(
            { key: "accessToken", type: "secret" },
            auth.accessToken.trim(),
          )
        }
        if (typeof auth.refreshToken === "string" && auth.refreshToken) {
          this.setAccountFieldValue(
            { key: "refreshToken", type: "secret" },
            auth.refreshToken.trim(),
          )
        }
        // 自动填充 label：优先用 account.nickname
        const account = obj.account
        if (
          account
          && typeof account.nickname === "string"
          && account.nickname
          && !this.newAccount.label
        ) {
          this.newAccount.label = `CodeBuddy-${account.nickname}`
        }
      } catch {
        // JSON 解析失败时静默忽略，用户可能还在输入
      }
    },

    /** 解析 LobsterAI 凭证 JSON，自动填充 label / accessToken / refreshToken。 */
    parseLobsteraiJson() {
      const str = this.lobsteraiJsonInput.trim()
      if (!str) return
      try {
        const obj = JSON.parse(str)
        // 支持多种格式：
        //   { access_token, refresh_token, nickname }  （auto-checkin 导出格式）
        //   { accessToken, refreshToken }              （客户端 camelCase）
        //   { LobsterAI: { access_token, ... } }       （按站点名嵌套）
        const inner =
          obj.access_token || obj.accessToken ? obj
          : obj.LobsterAI && typeof obj.LobsterAI === "object" ? obj.LobsterAI
          : obj
        const accessToken =
          inner.access_token ?? inner.accessToken ?? inner.token
        if (typeof accessToken === "string" && accessToken) {
          this.setAccountFieldValue(
            { key: "accessToken", type: "secret" },
            accessToken.trim(),
          )
        }
        const refreshToken = inner.refresh_token ?? inner.refreshToken
        if (typeof refreshToken === "string" && refreshToken) {
          this.setAccountFieldValue(
            { key: "refreshToken", type: "secret" },
            refreshToken.trim(),
          )
        }
        const nickname = inner.nickname
        if (
          typeof nickname === "string"
          && nickname
          && !this.newAccount.label
        ) {
          this.newAccount.label = `LobsterAI-${nickname}`
        }
      } catch {
        // JSON 解析失败时静默忽略，用户可能还在输入
      }
    },

    /**
     * 上传 LobsterAI 客户端数据库（lobsterai.sqlite），由服务端解析出凭证。
     *
     * 解析放在服务端：copilot-api 常部署在远端，读不到用户本机的库文件；
     * 且浏览器端解析 SQLite 需要额外的 WASM 依赖。
     */
    async lobsteraiDbSelected(event) {
      const file = event.target.files?.[0]
      if (!file) return
      this.lobsteraiDbLoading = true
      try {
        const result = await API.accounts.parseLobsteraiDb(file)
        const creds = result.credentials || {}
        for (const key of ["accessToken", "refreshToken"]) {
          if (typeof creds[key] === "string" && creds[key]) {
            this.setAccountFieldValue({ key, type: "secret" }, creds[key])
          }
        }
        // keyfrom / uuid / userId 随创建请求一起提交，刷新 token 时回传。
        for (const key of ["uuid", "userId", "firstKeyfrom", "latestKeyfrom"]) {
          if (typeof creds[key] === "string" && creds[key]) {
            this.newAccount.credentials = {
              ...this.newAccount.credentials,
              [key]: creds[key],
            }
          }
        }
        const nickname = result.profile?.nickname
        if (nickname && !this.newAccount.label) {
          this.newAccount.label = `LobsterAI-${nickname}`
        }
        this.showToast(
          I18n.t("accounts.provider.lobsterai.dbParsed"),
          "success",
        )
      } catch (error) {
        this.showToast(error?.message || String(error), "error")
      } finally {
        this.lobsteraiDbLoading = false
        // 允许重复选择同一个文件
        event.target.value = ""
      }
    },
    editingLabel: null,
    editLabelValue: "",
    modelSearch: {},
    // 账号模型管理(与 provider 共用同一套语义:开关/改名/别名;
    // 上游 ID 由供应商决定只读,不提供增删,后端亦有 guard)
    showAccountModels: false,
    accountModelsConn: null,
    accountModelsSearch: "",
    accountModelsEditingId: null,
    accountModelsEditValue: "",
    accountModelsAliasFor: null,
    accountModelsAliasInput: "",

    async load() {
      this.loading = true
      try {
        const [data, providerData] = await Promise.all([
          API.accounts.list(),
          API.providers.list(),
        ])
        this.accounts = data.accounts || []
        this.providers = providerData.providers || []
      } catch {
        this.showToast(I18n.t("error.load"), "error")
      } finally {
        this.loading = false
        this.$nextTick(() => lucide.createIcons())
      }
    },

    providerIcon(providerId) {
      const provider = this.providers.find((item) => item.id === providerId)
      return (
        provider?.icon
        || (providerId === "codebuff" ? "bot"
        : providerId === "windsurf" ? "wind"
        : "github")
      )
    },

    providerLabel(providerId) {
      const provider = this.providers.find((item) => item.id === providerId)
      return (
        provider?.name
        || I18n.t(`accounts.provider.${providerId}.name`)
        || providerId
      )
    },

    /**
     * Preferred provider order for account sections. Keeps dense providers
     * (xai/codex with many models) separate from sparse ones so card heights
     * stay consistent within each group.
     */
    PROVIDER_ORDER: [
      "copilot",
      "codex",
      "xai",
      "claude",
      "antigravity",
      "kimi",
      "windsurf",
      "codebuff",
      "mimo-aistudio",
    ],

    getAccountsByProvider(provider) {
      return (this.accounts || []).filter(
        (a) => (a.provider || "copilot") === provider,
      )
    },

    /**
     * Providers that currently have at least one account, sorted.
     * Dense providers (many models / quota rows) use a wider grid.
     */
    getProviderGroups() {
      const counts = new Map()
      for (const account of this.accounts || []) {
        const provider = account.provider || "copilot"
        counts.set(provider, (counts.get(provider) || 0) + 1)
      }
      const known = this.PROVIDER_ORDER.filter((p) => counts.has(p))
      const extras = [...counts.keys()]
        .filter((p) => !this.PROVIDER_ORDER.includes(p))
        .sort()
      return [...known, ...extras].map((provider) => ({
        provider,
        count: counts.get(provider) || 0,
        accounts: this.getAccountsByProvider(provider),
        dense: false,
      }))
    },

    selectedProvider() {
      return (
        this.providers.find(
          (provider) => provider.id === this.newAccount.provider,
        ) || null
      )
    },

    selectedProviderFields() {
      return this.selectedProvider()?.accountFields || []
    },

    fieldLabel(field) {
      return I18n.t(field.labelKey) || field.key
    },

    getAccountFieldValue(field) {
      if (field.key in (this.newAccount.credentials || {})) {
        return this.newAccount.credentials[field.key]
      }
      return this.newAccount.settings?.[field.key]
    },

    setAccountFieldValue(field, value) {
      if (field.type === "secret") {
        this.newAccount.credentials = {
          ...this.newAccount.credentials,
          [field.key]: value,
        }
        return
      }

      this.newAccount.settings = {
        ...this.newAccount.settings,
        [field.key]: value,
      }
    },

    startEditLabel(account) {
      this.editingLabel = account.id
      this.editLabelValue = account.label
      this.$nextTick(() => {
        const input = this.$refs.labelInput
        if (input) input.focus()
      })
    },

    async saveLabel(account) {
      if (!this.editLabelValue.trim()) {
        this.editingLabel = null
        return
      }
      const newLabel = this.editLabelValue.trim()
      try {
        await API.accounts.update(account.id, { label: newLabel })
        this.showToast(
          I18n.t("accounts.updateSuccess") || "Account name updated",
          "success",
        )
        account.label = newLabel
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      } finally {
        this.editingLabel = null
      }
    },

    needsManualOAuthCallback(provider = this.newAccount.provider) {
      return MANUAL_OAUTH_CALLBACK_PROVIDERS.has(provider)
    },

    oauthCallbackLabel() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackLabel`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackLabel")
    },

    oauthCallbackPlaceholder() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackPlaceholder`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackPlaceholder")
    },

    oauthCallbackHint() {
      const provider = this.newAccount.provider
      const key = `accounts.oauth.${provider}CallbackHint`
      return I18n.t(key) || I18n.t("accounts.oauth.callbackHint")
    },

    async cancelOAuthFlow() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      if (!flowId || this.selectedProvider()?.authMode !== "oauth") {
        return
      }
      try {
        await API.oauth.cancel(provider, { flowId })
      } catch {
        // Ignore cancel errors.
      }
    },

    /** 重置新增/重认证弹窗的全部临时状态。 */
    resetAddModalState() {
      this.newAccount = this.defaultNewAccount()
      this.reauthAccount = null
      this.deviceFlowStep = "input"
      this.deviceFlowData = null
      this.oauthFlowData = null
      this.oauthCallbackInput = ""
      this.oauthCallbackSubmitting = false
      this.mimoCookieInput = ""
      this.codebuddyJsonInput = ""
      this.lobsteraiJsonInput = ""
      if (this.pollTimer) clearTimeout(this.pollTimer)
      this.pollTimer = null
    },

    openAddModal() {
      this.resetAddModalState()
      this.showAddModal = true
    },

    /**
     * 原地重认证：复用 OAuth 新增流程，但把新 token 写回原账号
     *（保留 id/label/用量统计）。仅 OAuth provider 且 authStatus=error 时展示。
     */
    openReauthModal(account) {
      this.resetAddModalState()
      this.newAccount.provider = account.provider
      this.newAccount.label = account.label || ""
      this.reauthAccount = account
      this.showAddModal = true
    },

    isReauthFlow() {
      return Boolean(this.reauthAccount)
    },

    async closeAddModal() {
      if (this.deviceFlowStep === "pending") {
        await this.cancelOAuthFlow()
      }

      this.resetAddModalState()
      this.showAddModal = false
    },

    async submitAccount() {
      this.pollTimer = null
      try {
        const authMode = this.selectedProvider()?.authMode
        if (authMode === "oauth") {
          try {
            await this.startOAuthFlow()
          } catch (error) {
            const message =
              error instanceof Error ? error.message : I18n.t("error.create")
            this.showToast(message, "error")
          }
          return
        }

        const provider = this.newAccount.provider || "copilot"
        const payload = {
          label: this.newAccount.label.trim() || undefined,
          provider,
          credentials: Object.fromEntries(
            Object.entries(this.newAccount.credentials || {}).filter(
              ([, value]) => value !== "" && value !== undefined,
            ),
          ),
          settings: Object.fromEntries(
            Object.entries(this.newAccount.settings || {}).filter(
              ([, value]) => value !== "" && value !== undefined,
            ),
          ),
        }
        const res = await API.accounts.create(payload)
        if (this.selectedProvider()?.authMode === "device_flow") {
          if (!res?.flowId || !res?.userCode || !res?.verificationUri) {
            throw new Error("Invalid device flow response")
          }
          this.deviceFlowData = res
          this.deviceFlowStep = "pending"
          this.pollDeviceFlow()
          return
        }
        if (res?.status && res.status !== "complete") {
          throw new Error("Unexpected account creation status")
        }
        this.deviceFlowStep = "success"
        await this.load()
      } catch {
        this.showToast(I18n.t("error.create"), "error")
      }
    },

    pollDeviceFlow() {
      let pollInterval = this.deviceFlowData?.interval * 1000 || 5000

      const doPoll = async () => {
        if (this.deviceFlowStep !== "pending") {
          return
        }
        try {
          const flowId =
            this.deviceFlowData.flowId || this.deviceFlowData.deviceCode
          const res = await API.accountFlows.poll(flowId)
          if (res.status === "complete") {
            this.deviceFlowStep = "success"
            // Refresh accounts list to show the new account
            await this.load()
            return
          }
          if (res.status === "expired") {
            this.deviceFlowStep = "input"
            this.showToast(
              I18n.t("accounts.deviceFlow.expired")
                || "Device flow expired. Please try again.",
              "error",
            )
            return
          }
          // Update interval if server asks for slow_down
          if (res.interval) {
            pollInterval = res.interval * 1000
          }
        } catch {
          // Continue polling
        }
        // Schedule next poll with current interval
        this.pollTimer = setTimeout(doPoll, pollInterval)
      }

      this.pollTimer = setTimeout(doPoll, pollInterval)
    },

    async startOAuthFlow() {
      const provider = this.newAccount.provider
      const proxyUrl = this.newAccount.settings?.proxyUrl?.trim()
      const manual = this.needsManualOAuthCallback(provider)
      const payload = {
        label: this.newAccount.label.trim() || undefined,
        proxyUrl: proxyUrl || undefined,
        manual,
      }
      if (this.reauthAccount) {
        payload.reauthAccountId = this.reauthAccount.id
      }
      const res = await API.oauth.start(provider, payload)
      if (!res?.flowId) {
        throw new Error("Invalid OAuth flow response")
      }
      this.oauthFlowData = res
      this.oauthCallbackInput = ""
      this.deviceFlowStep = "pending"
      if (res.authUrl) {
        globalThis.open(res.authUrl, "_blank", "noopener,noreferrer")
      } else if (res.verificationUri) {
        globalThis.open(res.verificationUri, "_blank", "noopener,noreferrer")
      }
      this.pollOAuthFlow()
    },

    async submitOAuthCallback() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      const callback = this.oauthCallbackInput.trim()
      if (!flowId || !callback) {
        this.showToast(
          provider === "xai" ?
            I18n.t("accounts.oauth.xaiCallbackRequired")
          : I18n.t("accounts.oauth.callbackRequired"),
          "error",
        )
        return
      }

      this.oauthCallbackSubmitting = true
      try {
        const res = await API.oauth.complete(provider, {
          flowId,
          callback,
        })
        if (res.status === "complete") {
          this.deviceFlowStep = "success"
          await this.load()
          return
        }
        throw new Error(res.error || "OAuth completion failed")
      } catch (error) {
        const message =
          error instanceof Error ?
            error.message
          : I18n.t("accounts.oauth.error")
        this.showToast(message, "error")
      } finally {
        this.oauthCallbackSubmitting = false
      }
    },

    pollOAuthFlow() {
      const provider = this.newAccount.provider
      const flowId = this.oauthFlowData?.flowId
      let pollInterval = (this.oauthFlowData?.interval || 5) * 1000

      const doPoll = async () => {
        if (this.deviceFlowStep !== "pending" || !flowId) {
          return
        }
        try {
          const res = await API.oauth.poll(provider, flowId)
          if (res.status === "complete") {
            this.deviceFlowStep = "success"
            await this.load()
            return
          }
          if (res.status === "error") {
            await this.cancelOAuthFlow()
            this.deviceFlowStep = "input"
            this.oauthFlowData = null
            this.showToast(res.error || I18n.t("accounts.oauth.error"), "error")
            return
          }
          if (res.status === "expired") {
            await this.cancelOAuthFlow()
            this.deviceFlowStep = "input"
            this.oauthFlowData = null
            this.showToast(I18n.t("accounts.oauth.expired"), "error")
            return
          }
          if (res.interval) {
            pollInterval = res.interval * 1000
          }
        } catch {
          // Continue polling
        }
        this.pollTimer = setTimeout(doPoll, pollInterval)
      }

      this.pollTimer = setTimeout(doPoll, pollInterval)
    },

    formatQuotaSummary(account) {
      return QuotaDisplay.formatSummary(account, (key, params) =>
        this.t(key, params),
      )
    },

    async refreshAccountQuota(account) {
      if (!account?.id || account.supportsQuota === false) return
      this.refreshingQuotaId = account.id
      try {
        const result = await API.quota.refreshOne(account.id)
        const idx = this.accounts.findIndex((item) => item.id === account.id)
        if (idx !== -1) {
          this.accounts[idx] = {
            ...this.accounts[idx],
            quotaInfo: result.quotaInfo ?? this.accounts[idx].quotaInfo,
            quotaState: result.quotaState ?? this.accounts[idx].quotaState,
          }
        }
        this.showToast(I18n.t("accounts.quotaRefreshSuccess"), "success")
      } catch {
        this.showToast(I18n.t("accounts.quotaRefreshError"), "error")
      } finally {
        this.refreshingQuotaId = null
      }
    },

    async toggleEnabled(account) {
      const nextEnabled = !account.enabled
      try {
        await API.accounts.update(account.id, { enabled: nextEnabled })
        this.showToast(
          account.enabled ?
            I18n.t("accounts.disableSuccess")
          : I18n.t("accounts.enableSuccess"),
          "success",
        )
        account.enabled = nextEnabled
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async savePriority(account) {
      const priority = Math.max(0, Math.min(100, account.priority ?? 0))
      try {
        await API.accounts.update(account.id, { priority })
        this.showToast(
          I18n.t("accounts.prioritySuccess") || "Priority updated",
          "success",
        )
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    /**
     * Whether an xAI account is set to use the official API endpoint.
     * Defaults to false (Grok CLI chat-proxy).
     */
    isXaiUsingApi(account) {
      return account.settings?.useApi === true
    },

    /**
     * Toggle an xAI account between the Grok CLI chat-proxy (default) and the
     * official API endpoint for HTTP chat. WebSocket traffic always uses the
     * official API regardless of this setting.
     */
    async toggleXaiUseApi(account) {
      const nextUseApi = !this.isXaiUsingApi(account)
      try {
        await API.accounts.update(account.id, {
          settings: { useApi: nextUseApi },
        })
        account.settings = { ...account.settings, useApi: nextUseApi }
        this.showToast(
          I18n.t("accounts.updateSuccess") || "Account updated",
          "success",
        )
      } catch {
        this.showToast(I18n.t("error.update"), "error")
      }
    },

    async decreasePriority(account) {
      const newPriority = Math.max(0, (account.priority ?? 0) - 1)
      account.priority = newPriority
      await this.savePriority(account)
    },

    async increasePriority(account) {
      const newPriority = Math.min(100, (account.priority ?? 0) + 1)
      account.priority = newPriority
      await this.savePriority(account)
    },

    async deleteAccount(id) {
      if (!confirm(I18n.t("accounts.confirmDelete"))) return
      try {
        await API.accounts.delete(id)
        this.showToast(I18n.t("accounts.deleteSuccess"), "success")
        this.accounts = this.accounts.filter((item) => item.id !== id)
      } catch {
        this.showToast(I18n.t("error.delete"), "error")
      }
    },

    async exportAccounts() {
      try {
        const response = await API.accounts.export()
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename = match ? match[1] : "copilot-api-accounts.json"
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(I18n.t("accounts.exportSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    async exportOneAccount(account) {
      try {
        const response = await API.accounts.exportOne(account.id)
        const blob = await response.blob()
        const disposition = response.headers.get("Content-Disposition") || ""
        const match = disposition.match(/filename="?([^"]+)"?/)
        const filename = match ? match[1] : "copilot-api-account.json"
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        this.showToast(I18n.t("accounts.exportOneSuccess"), "success")
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    openImportModal() {
      this.importFiles = []
      this.importSkipDuplicates = true
      this.importMode = "standard"
      this.showImportModal = true
      this.$nextTick(() => {
        if (this.$refs.importFileInput) this.$refs.importFileInput.value = ""
      })
    },

    closeImportModal() {
      this.showImportModal = false
      this.importFiles = []
    },

    importFileSelected(event) {
      const list = event.target.files
      this.importFiles = list && list.length > 0 ? Array.from(list) : []
    },

    /** Collect CPA auth records from one or many JSON files (CPA auths/* style). */
    async parseCpaImportFiles(files) {
      const records = []
      const parseErrors = []
      for (const file of files) {
        try {
          const text = await file.text()
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed)) {
            records.push(...parsed)
          } else if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.accounts)) {
              records.push(...parsed.accounts)
            } else if (Array.isArray(parsed.auths)) {
              records.push(...parsed.auths)
            } else {
              // Single CPA auth object (typical auths/foo.json)
              records.push(parsed)
            }
          } else {
            parseErrors.push(file.name)
          }
        } catch {
          parseErrors.push(file.name)
        }
      }
      return { records, parseErrors }
    },

    async parseStandardImportFiles(files) {
      const accounts = []
      const parseErrors = []
      for (const file of files) {
        try {
          const text = await file.text()
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed)) {
            accounts.push(...parsed)
          } else if (parsed && Array.isArray(parsed.accounts)) {
            accounts.push(...parsed.accounts)
          } else {
            parseErrors.push(file.name)
          }
        } catch {
          parseErrors.push(file.name)
        }
      }
      return { accounts, parseErrors }
    },

    async submitImport() {
      if (!this.importFiles || this.importFiles.length === 0) {
        this.showToast(I18n.t("accounts.importNoFile"), "error")
        return
      }

      try {
        let result
        if (this.importMode === "cpa") {
          const { records, parseErrors } = await this.parseCpaImportFiles(
            this.importFiles,
          )
          if (parseErrors.length > 0 && records.length === 0) {
            this.showToast(I18n.t("accounts.importInvalidFile"), "error")
            return
          }
          if (records.length === 0) {
            this.showToast(I18n.t("accounts.importInvalidFile"), "error")
            return
          }
          result = await API.accounts.importCpa({
            records,
            overwrite: !this.importSkipDuplicates,
          })
          if (parseErrors.length > 0) {
            result = {
              ...result,
              failed: (result.failed || 0) + parseErrors.length,
            }
          }
        } else {
          const { accounts, parseErrors } = await this.parseStandardImportFiles(
            this.importFiles,
          )
          if (accounts.length === 0) {
            this.showToast(I18n.t("accounts.importInvalidFile"), "error")
            return
          }
          result = await API.accounts.import({
            accounts,
            overwrite: !this.importSkipDuplicates,
          })
          if (parseErrors.length > 0) {
            result = {
              ...result,
              failed: (result.failed || 0) + parseErrors.length,
            }
          }
        }

        let msg = I18n.t("accounts.importSuccess", { count: result.imported })
        if (result.skipped > 0)
          msg += I18n.t("accounts.importSkipped", { count: result.skipped })
        if (result.failed > 0)
          msg += I18n.t("accounts.importFailed", { count: result.failed })
        this.showToast(msg, result.imported > 0 ? "success" : "info")
        this.closeImportModal()
        await this.load()
      } catch (e) {
        this.showToast(e.message || I18n.t("error.create"), "error")
      }
    },

    getFilteredModels(account) {
      const q = (this.modelSearch[account.id] || "").toLowerCase()
      if (!q) return account.availableModels || []
      return (account.availableModels || []).filter((m) => {
        return (
          (m.id || "").toLowerCase().includes(q)
          || (m.name || "").toLowerCase().includes(q)
          || (m.vendor || "").toLowerCase().includes(q)
        )
      })
    },

    // ── 账号模型管理 ─────────────────────────────────────────────
    // 走 accounts 模型子路由(与 provider 管理抽屉同一套语义:开关/改名/别名),
    // 上游 ID 只读、不提供增删,卡片上的 availableModels 保持只读展示。

    async openAccountModels(account) {
      try {
        const res = await API.accounts.getModels(account.id)
        this.accountModelsConn = {
          id: account.id,
          models: res.models || [],
        }
        this.accountModelsSearch = ""
        this.accountModelsEditingId = null
        this.accountModelsEditValue = ""
        this.accountModelsAliasFor = null
        this.accountModelsAliasInput = ""
        this.showAccountModels = true
        this.$nextTick(() => lucide.createIcons())
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    closeAccountModels() {
      this.showAccountModels = false
      this.accountModelsConn = null
    },

    get accountModelsFiltered() {
      const models = this.accountModelsConn?.models || []
      const q = (this.accountModelsSearch || "").trim().toLowerCase()
      if (!q) return models
      return models.filter(
        (m) =>
          (m.publicId || "").toLowerCase().includes(q)
          || (m.upstreamId || "").toLowerCase().includes(q),
      )
    },

    async reloadAccountModels() {
      if (!this.accountModelsConn) return
      try {
        const res = await API.accounts.getModels(this.accountModelsConn.id)
        this.accountModelsConn.models = res.models || []
        await this.load()
      } catch (e) {
        this.showToast(e.message || I18n.t("error.load"), "error")
      }
    },

    async accountModelsToggle(m) {
      if (!this.accountModelsConn) return
      try {
        await API.accounts.updateModel(this.accountModelsConn.id, m.publicId, {
          enabled: !m.enabled,
        })
        m.enabled = !m.enabled
        await this.load()
      } catch (e) {
        this.showToast(e.message || I18n.t("error.update"), "error")
      }
    },

    startAccountRename(m) {
      this.accountModelsEditingId = m.publicId
      this.accountModelsEditValue = m.publicId
      this.accountModelsAliasFor = null
      this.accountModelsAliasInput = ""
    },

    cancelAccountRename() {
      this.accountModelsEditingId = null
      this.accountModelsEditValue = ""
    },

    async saveAccountRename(m) {
      if (!this.accountModelsConn) return
      const next = (this.accountModelsEditValue || "").trim()
      if (!next || next === m.publicId) {
        this.cancelAccountRename()
        return
      }
      try {
        await API.accounts.updateModel(this.accountModelsConn.id, m.publicId, {
          publicId: next,
        })
        this.cancelAccountRename()
        await this.reloadAccountModels()
        this.showToast(
          I18n.t("accounts.updateSuccess") || "Account updated",
          "success",
        )
      } catch (e) {
        this.showToast(e.message || I18n.t("error.update"), "error")
      }
    },

    toggleAccountAliasEditor(m) {
      if (this.accountModelsAliasFor === m.publicId) {
        this.accountModelsAliasFor = null
        this.accountModelsAliasInput = ""
      } else {
        this.cancelAccountRename()
        this.accountModelsAliasFor = m.publicId
        this.accountModelsAliasInput = ""
      }
    },

    async addAccountModelAlias(m) {
      if (!this.accountModelsConn) return
      const value = (this.accountModelsAliasInput || "").trim()
      if (!value) return
      const current = m.aliases || []
      if (current.some((a) => a.toLowerCase() === value.toLowerCase())) {
        this.accountModelsAliasInput = ""
        return
      }
      try {
        await API.accounts.updateModel(this.accountModelsConn.id, m.publicId, {
          aliases: [...current, value],
        })
        m.aliases = [...current, value]
        this.accountModelsAliasInput = ""
      } catch (e) {
        this.showToast(e.message || I18n.t("error.update"), "error")
      }
    },

    async removeAccountModelAlias(m, alias) {
      if (!this.accountModelsConn) return
      const next = (m.aliases || []).filter((a) => a !== alias)
      try {
        await API.accounts.updateModel(this.accountModelsConn.id, m.publicId, {
          aliases: next,
        })
        m.aliases = next
      } catch (e) {
        this.showToast(e.message || I18n.t("error.update"), "error")
      }
    },

    isUniqueSubtitle(subtitle) {
      if (!subtitle) return false
      return (
        (this.accounts || []).filter((a) => a.subtitle === subtitle).length
        === 1
      )
    },
  }
}

// Connections View Component
