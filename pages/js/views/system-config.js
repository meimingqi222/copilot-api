function systemConfigView() {
  return {
    settings: null,
    source: "",
    expiresAt: null,
    debugMinutes: 15,
    maxLogMiB: 1024,
    acknowledgeSensitiveData: false,
    loading: false,
    saving: false,
    error: "",
    saved: false,
    codexModels: [],
    codexModelsError: "",
    codexModelSearch: "",
    redactionWordsText: "",
    redactionHomePrefixesText: "",
    warmupTimesText: "",
    warmupModels: {},
    warmupModelsError: "",
    warmupModelsLoading: false,
    warmupTimeZoneOpen: false,
    warmupTimeZoneSearch: "",
    warmupTimeZoneActive: 0,
    warmupTimeZones: [],

    prepareWarmupTimeZones(full = false) {
      const common = [
        [
          "Asia/Shanghai",
          "北京 / 上海",
          "Beijing / Shanghai",
          "中国 china beijing shanghai",
        ],
        ["Asia/Hong_Kong", "香港", "Hong Kong", "香港 hongkong"],
        ["Asia/Tokyo", "东京", "Tokyo", "日本 japan"],
        ["Asia/Singapore", "新加坡", "Singapore", "新加坡"],
        ["UTC", "协调世界时", "Coordinated Universal Time", "协调世界时"],
        ["Europe/London", "伦敦", "London", "英国 uk"],
        ["America/New_York", "纽约", "New York", "美国 usa"],
        ["America/Los_Angeles", "洛杉矶", "Los Angeles", "美国 usa"],
      ]
      const language = I18n.currentLang() === "zh" ? "zh-CN" : "en-US"
      const now = new Date()
      const current = this.settings.accountWarmup.timeZone
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone
      const ids = [
        ...new Set([
          current,
          local,
          ...common.map(([id]) => id),
          ...(full ? Intl.supportedValuesOf("timeZone") : []),
        ]),
      ]
      this.warmupTimeZones = ids.map((id) => {
        const city = common.find(([zone]) => zone === id)
        const localized = new Intl.DateTimeFormat(language, {
          timeZone: id,
          timeZoneName: "longGeneric",
        })
          .formatToParts(now)
          .find((part) => part.type === "timeZoneName").value
        const name =
          city ?
            city[language === "zh-CN" ? 1 : 2]
          : id.split("/").at(-1).replaceAll("_", " ")
        const offset = new Intl.DateTimeFormat("en", {
          timeZone: id,
          timeZoneName: "longOffset",
        })
          .formatToParts(now)
          .find((part) => part.type === "timeZoneName")
          .value.replace("GMT", "UTC")
        return {
          id,
          name,
          offset,
          search:
            `${id} ${name} ${localized} ${city?.join(" ") || ""} ${offset}`.toLowerCase(),
        }
      })
    },

    get filteredWarmupTimeZones() {
      const query = this.warmupTimeZoneSearch
        .trim()
        .toLowerCase()
        .replace(
          /^(?:utc|gmt)([+-])(\d{1,2})(?::?(\d{2}))?$/,
          (_, sign, hour, minute) =>
            `utc${sign}${hour.padStart(2, "0")}:${minute || "00"}`,
        )
      const current = this.settings?.accountWarmup.timeZone
      const ordered = this.warmupTimeZones.filter((zone) =>
        zone.search.includes(query),
      )
      return ordered.sort((a, b) =>
        a.id === current ? -1
        : b.id === current ? 1
        : 0,
      )
    },

    get warmupTimeZoneLabel() {
      const id = this.settings?.accountWarmup.timeZone
      const zone = this.warmupTimeZones.find((entry) => entry.id === id)
      return zone ? `${zone.name} (${zone.offset})` : id
    },

    openWarmupTimeZone() {
      this.prepareWarmupTimeZones(true)
      this.warmupTimeZoneSearch = ""
      this.warmupTimeZoneActive = 0
      this.warmupTimeZoneOpen = true
      this.$nextTick(() => this.$refs.warmupTimeZoneSearch.focus())
    },

    closeWarmupTimeZone() {
      this.warmupTimeZoneOpen = false
      this.$refs.warmupTimeZoneTrigger.focus()
    },

    selectWarmupTimeZone(id) {
      this.settings.accountWarmup.timeZone = id
      this.saved = false
      this.closeWarmupTimeZone()
    },

    useLocalWarmupTimeZone() {
      this.selectWarmupTimeZone(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
    },

    moveWarmupTimeZone(direction) {
      const count = this.filteredWarmupTimeZones.length
      if (!count) return
      this.warmupTimeZoneActive =
        (this.warmupTimeZoneActive + direction + count) % count
      this.$nextTick(() =>
        document
          .getElementById(`warmup-time-zone-${this.warmupTimeZoneActive}`)
          ?.scrollIntoView({ block: "nearest" }),
      )
    },

    warmupModelOptions(pool) {
      const options = (this.warmupModels[pool] || []).map((model) => ({
        ...model,
        unavailable: false,
      }))
      const selected = this.settings?.accountWarmup.models[pool]
      if (!selected || options.some((model) => model.id === selected))
        return options
      return [...options, { id: selected, name: selected, unavailable: true }]
    },

    warmupModelLabel(model) {
      const name =
        model.name === model.id ? model.id : `${model.name} (${model.id})`
      const label =
        model.unavailable ? "system.warmupModelUnavailable"
        : model.recommended ? "system.warmupModelRecommended"
        : "system.warmupModelOther"
      return `${name} · ${this.t(label)}`
    },

    async loadWarmupModels() {
      this.warmupModelsLoading = true
      this.warmupModelsError = ""
      try {
        this.warmupModels = (
          await API.request("/system-config/warmup-models")
        ).models
      } catch (error) {
        this.warmupModelsError = error.message
      } finally {
        this.warmupModelsLoading = false
      }
    },

    get filteredCodexModels() {
      const query = this.codexModelSearch.trim().toLowerCase()
      return this.codexModels.filter((model) =>
        `${model.id} ${model.name}`.toLowerCase().includes(query),
      )
    },

    setCustomCodexModels(enabled) {
      this.settings.codexModelIds = enabled ? [] : null
      this.saved = false
    },

    toggleCodexModel(id, checked) {
      const ids = this.settings.codexModelIds
      if (!ids) return
      if (!checked)
        this.settings.codexModelIds = ids.filter((value) => value !== id)
      else if (ids.length < 100 && !ids.includes(id)) ids.push(id)
      this.saved = false
    },

    moveCodexModel(index, direction) {
      const ids = this.settings.codexModelIds
      const next = index + direction
      if (!ids || next < 0 || next >= ids.length) return
      ;[ids[index], ids[next]] = [ids[next], ids[index]]
      this.saved = false
    },

    codexModelName(id) {
      return this.codexModels.find((model) => model.id === id)?.name || id
    },

    accept(data) {
      this.settings = data.settings
      this.settings.codexModelIds ??= null
      this.settings.concurrencyQueueLimit ??= 100
      this.settings.concurrencyQueueWaitSeconds ??= 30
      this.settings.defaultProxyUrl ??= ""
      this.settings.accountWarmup ??= {
        enabled: false,
        times: ["07:00", "12:00", "17:00", "22:00"],
        timeZone: "Asia/Shanghai",
      }
      this.settings.accountWarmup.models ??= {
        claude: "",
        codex: "",
        antigravityGemini: "",
        antigravityClaude: "",
      }
      this.warmupTimeZoneOpen = false
      this.prepareWarmupTimeZones()
      this.warmupTimesText = this.settings.accountWarmup.times.join(", ")
      this.redactionWordsText = this.settings.redaction?.words.join("\n") ?? ""
      this.redactionHomePrefixesText =
        this.settings.redaction?.homePrefixes.join("\n") ?? ""
      this.maxLogMiB = Math.ceil(data.settings.logMaxTotalBytes / (1024 * 1024))
      globalThis.dispatchEvent(
        new CustomEvent("quota-display-mode", {
          detail: data.settings.quotaDisplayMode || "remaining",
        }),
      )
      this.source = data.source
      this.expiresAt = data.expiresAt
      this.acknowledgeSensitiveData = false
    },

    async load() {
      this.loading = true
      this.error = ""
      this.saved = false
      void this.loadCodexModels()
      void this.loadWarmupModels()
      try {
        const config = await API.request("/system-config")
        this.accept(config)
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },

    async loadCodexModels() {
      this.codexModelsError = ""
      try {
        const catalog = await API.request("/system-config/codex-models")
        this.codexModels = catalog.models
      } catch (error) {
        this.codexModels = []
        this.codexModelsError = error.message
      }
    },

    useRecommended() {
      this.settings = {
        redaction: this.settings.redaction,
        logLevel: "info",
        requestDump: false,
        memoryVerbose: false,
        performanceDetails: true,
        concurrencyQueueLimit: 100,
        concurrencyQueueWaitSeconds: 30,
        codexAutoReset: false,
        accountWarmup: { ...this.settings.accountWarmup, enabled: false },
        codexModelIds: this.settings?.codexModelIds ?? null,
        quotaDisplayMode: "remaining",
        logRetentionDays: 7,
        logMaxTotalBytes: 1024 * 1024 * 1024,
      }
      this.maxLogMiB = 1024
      this.acknowledgeSensitiveData = false
      this.saved = false
    },

    async save() {
      if (
        this.settings.codexModelIds?.length === 0
        && !globalThis.confirm(I18n.t("system.codexModelsEmptyConfirm"))
      ) {
        return
      }
      this.saving = true
      this.error = ""
      this.saved = false
      try {
        this.accept(
          await API.request("/system-config", {
            method: "PUT",
            body: {
              ...this.settings,
              accountWarmup: {
                ...this.settings.accountWarmup,
                times: this.warmupTimesText.split(/[,，\s]+/).filter(Boolean),
              },
              redaction: {
                ...this.settings.redaction,
                words: this.redactionWordsText
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
                homePrefixes: this.redactionHomePrefixesText
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              },
              logMaxTotalBytes: Number(this.maxLogMiB) * 1024 * 1024,
              debugMinutes: Number(this.debugMinutes),
              acknowledgeSensitiveData: this.acknowledgeSensitiveData,
            },
          }),
        )
        this.saved = true
      } catch (error) {
        this.error = error.message
      } finally {
        this.saving = false
      }
    },
  }
}
