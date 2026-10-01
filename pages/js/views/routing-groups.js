/**
 * Routing groups — a named pool of members plus an ordered rule list.
 *
 * Mirrors the other view modules exactly: a global factory returning an data
 * object the markup binds to, spread over the shared `ViewHelpers` (which
 * bridges language and toasts to the root app), loaded as a plain script and
 * referenced from the page as `x-data="routingGroupsView()"`. It is
 * deliberately *not* an ES module: views are loaded with a bare `<script src>`
 * alongside `app.js`, where an `export` statement is a parse error, and a
 * module-scoped declaration would not land on the global object the markup
 * looks the factory up on.
 *
 * Every group-supplied value is rendered through `x-text` / `:value` in the
 * markup — this module never builds HTML strings, so ids and member names
 * escape themselves.
 *
 * Endpoints used (see routing-groups.README.md for the wiring and the exact
 * shape each backend route is expected to answer with):
 *
 *   GET    /admin/api/routing-groups              list
 *   POST   /admin/api/routing-groups              upsert one group
 *   DELETE /admin/api/routing-groups/:id          delete one group
 *   GET    /admin/api/routing-groups/references   `group/<id>` values
 *   GET    /admin/api/routing-groups/meta         optional hints (levels, agents)
 */
function routingGroupsView() {
  /** Reasoning levels, lowest first — mirrors EFFORT_LEVELS in the backend. */
  const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]
  /** Not a level: it accepts any request that asked for reasoning at all. */
  const EFFORT_ANY = "on"
  /** Day names in display order (Monday first), spelled the way the store does. */
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
  /** "H:MM" or "HH:MM", local time, as `parseTime` accepts it. */
  const TIME_PATTERN = /^(?:\d|0\d|1\d|2[0-3]):[0-5]\d$/

  function toText(value) {
    if (value === undefined || value === null) return ""
    return String(value)
  }

  /** `provider/model` shaped, i.e. something a `:<suffix>` may be taken off. */
  function isMemberShape(model) {
    const slash = model.indexOf("/")
    return slash > 0 && slash < model.length - 1
  }

  /**
   * A member id with its `:effort` / `:fast` suffixes removed — the read the
   * backend performs with `cleanMember`, minus the model catalog the browser
   * does not have. A suffix is only taken off when what remains still looks
   * like `provider/model`, so a real id ending in `:free` keeps it.
   */
  function bareMember(id) {
    let bare = toText(id).trim()
    for (let pass = 0; pass < 2; pass++) {
      const colon = bare.lastIndexOf(":")
      if (colon <= 0) break
      const model = bare.slice(0, colon)
      const suffix = bare
        .slice(colon + 1)
        .trim()
        .toLowerCase()
      if (suffix !== "fast" && !EFFORT_LEVELS.includes(suffix)) break
      if (!isMemberShape(model)) break
      bare = model
    }
    return bare.trim()
  }

  /** tri-state form value for an optional boolean condition. */
  function booleanChoice(value) {
    if (value === undefined || value === null) return ""
    return value ? "true" : "false"
  }

  function listOf(value) {
    if (Array.isArray(value)) return value
    return value === undefined || value === null ? [] : [value]
  }

  function emptyRule() {
    return {
      use: "",
      tokens: "",
      images: "",
      effort: "",
      agents: "",
      intent: "",
      compact: "",
      timeEnabled: false,
      timeFrom: "",
      timeTo: "",
      timeDays: [],
    }
  }

  function blankForm() {
    return {
      id: "",
      name: "",
      expose: false,
      members: [],
      fastFlags: [],
      rules: [],
      pick: "",
      levels: [],
      levelsMode: "shared",
      routing: "smart",
      affinity: "",
      effort: "agent",
      classifier: { provider: "", model: "" },
    }
  }

  /** One reference as text; the endpoint may answer with strings or objects. */
  function describeReference(entry) {
    if (entry === undefined || entry === null) return ""
    if (typeof entry === "object") {
      const member =
        entry.member ?? entry.value ?? entry.model ?? entry.use ?? entry.from
      const via = entry.via ?? entry.source ?? entry.kind ?? entry.where
      const text = toText(member).trim()
      if (text === "") return ""
      return via ? `${text} (${toText(via)})` : text
    }
    return toText(entry).trim()
  }

  return {
    ...ViewHelpers,

    loading: false,
    saving: false,
    groups: [],
    /** Models the member picker offers, from `/routing-groups/models`. */
    memberOptions: [],
    /** Provider descriptors (id → icon), for the picker's provider tabs. */
    providers: [],
    /** Whether the picker panel is open. */
    memberPickerOpen: false,
    /** The picker's filter text. */
    memberSearch: "",
    /** The provider whose models the right pane lists; "all" lists every one. */
    selectedProvider: "all",
    /** Group id → the `group/<id>` values pointing at it. */
    references: {},
    /** Set when the references call failed, so the list can say so quietly. */
    referencesError: "",
    /** Optional payload from `/meta`; only used to widen the suggestion lists. */
    meta: null,
    showModal: false,
    editingId: null,
    form: blankForm(),

    slug(s) {
      if (!s) return ""
      return toText(s)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    },

    get computedId() {
      if (this.editingId) {
        return this.form.id || this.editingId
      }
      const name = toText(this.form.name).trim()
      if (this.form.id && this.form.id.trim() !== "") {
        return this.form.id.trim()
      }
      let id = this.slug(name) || "group"
      const base = id
      let n = 1
      while (this.groups.some((x) => x.id === id)) {
        id = `${base}-${++n}`
      }
      return id
    },

    get idHintText() {
      const id = this.computedId
      return this.t("routingGroups.idHintComputed", { id: `group/${id}` })
    },

    get hasClassifierNeed() {
      return (
        toText(this.form.effort).trim() === "auto"
        || this.form.rules.some((r) => toText(r.intent).trim() !== "")
      )
    },

    get classifierDisplayValue() {
      const p = toText(this.form.classifier?.provider).trim()
      const m = toText(this.form.classifier?.model).trim()
      if (p && m) return `${p}/${m}`
      if (m) return m
      return ""
    },

    setClassifierFromInput(val) {
      const raw = toText(val).trim()
      if (!raw) {
        this.form.classifier = { provider: "", model: "" }
        return
      }
      const slash = raw.indexOf("/")
      if (slash > 0) {
        this.form.classifier = {
          provider: raw.slice(0, slash).trim(),
          model: raw.slice(slash + 1).trim(),
        }
      } else {
        const opt = this.memberOptions.find(
          (o) => o.member === raw || o.modelId === raw,
        )
        if (opt) {
          this.form.classifier = {
            provider: opt.provider,
            model: opt.modelId || opt.member.split("/")[1] || opt.member,
          }
        } else {
          this.form.classifier = { provider: "", model: raw }
        }
      }
    },

    classifierHintText() {
      return this.t("routingGroups.classifierHint")
    },

    getMemberModel(member) {
      const bare = bareMember(member)
      return this.memberOptions.find((opt) => opt.member === bare)
    },

    getMemberName(member) {
      const model = this.getMemberModel(member)
      if (model?.name) return model.name
      const bare = bareMember(member)
      const slash = bare.indexOf("/")
      return slash > 0 ? bare.slice(slash + 1) : bare
    },

    getMemberProviderName(member) {
      const model = this.getMemberModel(member)
      if (model?.provider) return model.provider
      const bare = bareMember(member)
      const slash = bare.indexOf("/")
      return slash > 0 ? bare.slice(0, slash) : ""
    },

    getMemberEffort(member) {
      let str = toText(member).trim()
      if (str.endsWith(":fast")) str = str.slice(0, -5)
      const colon = str.lastIndexOf(":")
      if (colon > 0) {
        const suf = str.slice(colon + 1).toLowerCase()
        if (EFFORT_LEVELS.includes(suf)) return suf
      }
      return ""
    },

    setMemberEffort(index, effort) {
      const raw = this.form.members[index]
      const bare = bareMember(raw)
      const isFast = this.form.fastFlags[index]
      let next = bare
      if (effort && EFFORT_LEVELS.includes(effort)) {
        next += `:${effort}`
      }
      if (isFast) {
        next += ":fast"
      }
      this.form.members[index] = next
    },

    moveMember(index, offset) {
      const target = index + offset
      if (target < 0 || target >= this.form.members.length) return
      const [member] = this.form.members.splice(index, 1)
      const [fast] = this.form.fastFlags.splice(index, 1)
      this.form.members.splice(target, 0, member)
      this.form.fastFlags.splice(target, 0, fast)
    },

    routingHintText(mode) {
      const hints = {
        smart: this.t("routingGroups.routingHint.smart"),
        order: this.t("routingGroups.routingHint.order"),
        rotate: this.t("routingGroups.routingHint.rotate"),
        usage: this.t("routingGroups.routingHint.usage"),
        manual: this.t("routingGroups.routingHint.manual"),
      }
      return hints[mode] || hints.smart
    },

    affinityHintText(mode) {
      const hints = {
        "": this.t("routingGroups.affinityHint.inherit"),
        auto: this.t("routingGroups.affinityHint.auto"),
        session: this.t("routingGroups.affinityHint.session"),
        turn: this.t("routingGroups.affinityHint.turn"),
        off: this.t("routingGroups.affinityHint.off"),
      }
      return hints[mode] || hints.auto
    },

    effortHintText(mode) {
      const hints = {
        agent: this.t("routingGroups.effortHint.agent"),
        auto: this.t("routingGroups.effortHint.auto"),
      }
      return hints[mode] || hints.agent
    },

    // ── derived values ───────────────────────────────────────────────

    get effortLevels() {
      const announced = this.normalizedMetaList(["levels", "efforts"])
      const known = announced.filter((level) => EFFORT_LEVELS.includes(level))
      return known.length > 0 ? known : EFFORT_LEVELS
    },

    /** Member options grouped by provider, for the picker's optgroups. */
    get memberGroups() {
      const byProvider = new Map()
      for (const option of this.memberOptions) {
        const provider = option.provider || "(provider)"
        const list = byProvider.get(provider) ?? []
        list.push(option)
        byProvider.set(provider, list)
      }
      return [...byProvider.entries()].map(([provider, options]) => ({
        provider,
        options,
      }))
    },

    /** The picker's left rail: "all" first, then each provider. */
    get providerTabs() {
      return [
        {
          provider: "all",
          label: this.t("routingGroups.pickerAll"),
          count: this.memberOptions.length,
          all: true,
        },
        ...this.memberGroups.map((group) => ({
          provider: group.provider,
          label: group.provider,
          count: group.options.length,
          all: false,
        })),
      ]
    },

    /**
     * The right list, filtered by the rail's selection and the search box —
     * the rail itself never changes, so searching only re-renders this.
     */
    get visibleGroups() {
      const query = toText(this.memberSearch).trim().toLowerCase()
      const all =
        this.selectedProvider === "" || this.selectedProvider === "all"
      const base =
        all ?
          this.memberGroups
        : this.memberGroups.filter(
            (group) => group.provider === this.selectedProvider,
          )
      return base
        .map((group) => ({
          provider: group.provider,
          options:
            query === "" ?
              group.options
            : group.options.filter(
                (option) =>
                  option.member.toLowerCase().includes(query)
                  || option.name.toLowerCase().includes(query)
                  || group.provider.toLowerCase().includes(query),
              ),
        }))
        .filter((group) => group.options.length > 0)
    },

    /** Provider headers show only when the rail is on "all". */
    get showGroupHeaders() {
      return this.selectedProvider === "" || this.selectedProvider === "all"
    },

    /** The search text, when it names a model the list does not already offer. */
    get rawMemberCandidate() {
      const query = toText(this.memberSearch).trim()
      if (query === "") return ""
      if (this.memberOptions.some((option) => option.member === query)) {
        return ""
      }
      return query
    },

    /** id → icon, from the provider descriptors, lower-cased for lookup. */
    get providerIcons() {
      const map = {}
      for (const provider of this.providers) {
        const id = toText(provider?.id).toLowerCase()
        const icon = toText(provider?.icon)
        if (id !== "" && icon !== "") map[id] = icon
      }
      return map
    },

    /** The routing modes the group card offers, in display order. */
    get routingModes() {
      return [
        { value: "smart", label: "routingGroups.routing.smart" },
        { value: "order", label: "routingGroups.routing.order" },
        { value: "rotate", label: "routingGroups.routing.rotate" },
        { value: "usage", label: "routingGroups.routing.usage" },
        { value: "manual", label: "routingGroups.routing.manual" },
      ]
    },

    /** The session-affinity modes the group card offers. */
    get affinityModes() {
      return [
        { value: "", label: "routingGroups.affinity.inherit" },
        { value: "auto", label: "routingGroups.affinity.auto" },
        { value: "session", label: "routingGroups.affinity.session" },
        { value: "turn", label: "routingGroups.affinity.turn" },
        { value: "off", label: "routingGroups.affinity.off" },
      ]
    },

    /** Who decides each request's reasoning effort. */
    get effortModes() {
      return [
        { value: "agent", label: "routingGroups.effort.agent" },
        { value: "auto", label: "routingGroups.effort.auto" },
      ]
    },

    get effortChoices() {
      return [...this.effortLevels, EFFORT_ANY]
    },

    get dayNames() {
      return DAYS
    },

    /** Agent names the backend knows, if `/meta` bothers to report them. */
    get agentOptions() {
      return this.normalizedMetaList(["agents"])
    },

    /**
     * Read one list out of the optional `/meta` payload, whatever shape it
     * used: plain strings or `{ id | name | value }` records.
     */
    normalizedMetaList(keys) {
      const meta = this.meta
      if (!meta || typeof meta !== "object") return []
      for (const key of keys) {
        const raw = meta[key]
        if (!Array.isArray(raw)) continue
        const values = raw.map((entry) =>
          typeof entry === "object" && entry !== null ?
            (entry.id ?? entry.name ?? entry.value)
          : entry,
        )
        const cleaned = values
          .map((value) => toText(value).trim().toLowerCase())
          .filter((value) => value !== "")
        if (cleaned.length > 0) return [...new Set(cleaned)]
      }
      return []
    },

    /** Non-empty member ids as typed, in order, without duplicates. */
    memberChoices() {
      const seen = new Set()
      const choices = []
      for (const raw of this.form.members) {
        const member = toText(raw).trim()
        if (member === "" || seen.has(member)) continue
        seen.add(member)
        choices.push(member)
      }
      return choices
    },

    /** The model name a client types to reach this group. */
    modelName(group) {
      return `group/${toText(group?.id)}`
    },

    referencesFor(group) {
      return this.references[toText(group?.id)] ?? []
    },

    /** Whether the group prefers the fast variant of this member. */
    isFastMember(group, member) {
      const bare = bareMember(member)
      return listOf(group?.fast).some((entry) => bareMember(entry) === bare)
    },

    daysText(days) {
      const list = listOf(days)
        .map((day) => toText(day).trim().toLowerCase())
        .filter((day) => day !== "")
      if (list.length === 0 || list.length >= DAYS.length) {
        return this.t("routingGroups.everyDay")
      }
      return list.join(", ")
    },

    /** "3 members · 2 rules", for the list. */
    groupSummary(group) {
      return this.t("routingGroups.summary.counts", {
        members: listOf(group?.members).length,
        rules: listOf(group?.rules).length,
      })
    },

    /** One line describing when a stored rule is considered. */
    ruleSummary(rule) {
      const parts = []
      if (rule?.tokens !== undefined && rule?.tokens !== null) {
        parts.push(
          this.t("routingGroups.summary.tokens", { value: rule.tokens }),
        )
      }
      if (rule?.images === true)
        parts.push(this.t("routingGroups.summary.images"))
      if (rule?.images === false) {
        parts.push(this.t("routingGroups.summary.noImages"))
      }
      if (rule?.effort) {
        parts.push(
          this.t("routingGroups.summary.effort", { value: rule.effort }),
        )
      }
      if (listOf(rule?.agents).length > 0) {
        parts.push(
          this.t("routingGroups.summary.agents", {
            value: listOf(rule.agents).join(", "),
          }),
        )
      }
      if (rule?.intent) {
        parts.push(
          this.t("routingGroups.summary.intent", { value: rule.intent }),
        )
      }
      if (rule?.compact === true)
        parts.push(this.t("routingGroups.summary.compact"))
      if (rule?.compact === false) {
        parts.push(this.t("routingGroups.summary.notCompact"))
      }
      if (rule?.time) {
        parts.push(
          this.t("routingGroups.summary.time", {
            from: toText(rule.time.from),
            to: toText(rule.time.to),
            days: this.daysText(rule.time.days),
          }),
        )
      }
      return parts.length > 0 ?
          parts.join(" · ")
        : this.t("routingGroups.summary.always")
    },

    // ── loading ──────────────────────────────────────────────────────

    async load() {
      this.loading = true
      try {
        this.groups = this.normalizeGroups(await API.routingGroups.list())
      } catch (error) {
        this.showToast(error.message, "error")
      } finally {
        this.loading = false
      }
      await this.loadReferences()
      await this.loadMemberOptions()
      await this.loadProviders()
      await this.loadMeta()
      this.$nextTick(() => lucide.createIcons())
    },

    /** The list endpoint may answer with an array or wrap it in `{ groups }`. */
    normalizeGroups(payload) {
      const list = Array.isArray(payload) ? payload : payload?.groups
      if (!Array.isArray(list)) return []
      return list
        .filter((group) => group && typeof group === "object")
        .map((group) => ({
          ...group,
          id: toText(group.id),
          name: toText(group.name),
          members: listOf(group.members).map((member) => toText(member)),
          rules: listOf(group.rules),
        }))
    },

    /**
     * The values that point at a group, keyed by group id.
     *
     * Two shapes are tolerated, so the page keeps working whichever the route
     * settles on: a map `{ [id]: [ref, ...] }`, or a list of records like
     * `{ id | group, references: [...] }`. Entries may be strings or objects
     * naming where the reference sits.
     */
    async loadReferences() {
      try {
        this.references = this.normalizeReferences(
          await API.routingGroups.references(),
        )
        this.referencesError = ""
      } catch (error) {
        // The list of groups itself is still useful, so this stays quiet on
        // screen and only marks the panel as unavailable.
        this.references = {}
        this.referencesError = error.message
      }
    },

    normalizeReferences(payload) {
      const raw = payload?.references ?? payload
      const map = {}
      const add = (groupId, entry) => {
        const id = toText(groupId).trim()
        if (id === "") return
        const text = describeReference(entry)
        if (text === "") return
        const list = map[id] ?? []
        if (!list.includes(text)) list.push(text)
        map[id] = list
      }

      if (Array.isArray(raw)) {
        for (const record of raw) {
          if (!record || typeof record !== "object") continue
          const id =
            record.group ?? record.groupId ?? record.target ?? record.id
          const entries = record.references ?? record.refs ?? record.values
          for (const entry of listOf(entries)) add(id, entry)
        }
        return map
      }

      if (raw && typeof raw === "object") {
        for (const [id, entries] of Object.entries(raw)) {
          for (const entry of listOf(entries)) add(id, entry)
        }
      }
      return map
    },

    /** Hints only: a missing or unreadable `/meta` changes nothing. */
    async loadMeta() {
      try {
        const payload = await API.routingGroups.meta()
        const meta = payload?.meta ?? payload
        this.meta = meta && typeof meta === "object" ? meta : null
      } catch {
        this.meta = null
      }
    },

    /**
     * The models the member picker offers. A missing endpoint (older backend)
     * just leaves the list empty, so the free-text rows keep working.
     */
    async loadMemberOptions() {
      try {
        const payload = await API.routingGroups.models()
        const list = Array.isArray(payload) ? payload : payload?.models
        this.memberOptions = listOf(list)
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            member: toText(entry.member ?? entry.modelId).trim(),
            provider: toText(entry.provider).trim(),
            modelId: toText(entry.modelId).trim(),
            name: toText(entry.name).trim(),
            context: Number(entry.context) || 0,
            free: entry.free === true,
            efforts: listOf(entry.efforts).map((level) => toText(level)),
          }))
          .filter((entry) => entry.member !== "")
      } catch {
        this.memberOptions = []
      }
    },

    /** Provider descriptors (id → icon), so the picker can show provider icons. */
    async loadProviders() {
      try {
        const payload = await API.providers.list()
        const list = Array.isArray(payload) ? payload : payload?.providers
        this.providers = listOf(list).filter(
          (entry) => entry && typeof entry === "object",
        )
      } catch {
        this.providers = []
      }
    },

    // ── modal ────────────────────────────────────────────────────────

    openCreate() {
      this.editingId = null
      this.form = blankForm()
      this.showModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    openEdit(group) {
      this.editingId = group.id
      this.form = this.toDraft(group)
      this.showModal = true
      this.$nextTick(() => lucide.createIcons())
    },

    closeModal() {
      this.showModal = false
      this.editingId = null
      this.form = blankForm()
      this.memberPickerOpen = false
      this.memberSearch = ""
      this.selectedProvider = ""
    },

    /** A stored group as editable rows: every condition has a field. */
    toDraft(group) {
      const stored = listOf(group?.members).map((member) => toText(member))
      const members = stored.filter((m) => m !== "")
      const fast = new Set(
        listOf(group?.fast).map((entry) => bareMember(entry)),
      )
      const levels = new Set(
        listOf(group?.levels).map((level) => toText(level)),
      )
      return {
        id: toText(group?.id),
        name: toText(group?.name),
        expose: group?.expose === true,
        members,
        fastFlags: members.map((member) => fast.has(bareMember(member))),
        rules: listOf(group?.rules).map((rule) => this.ruleToDraft(rule)),
        pick: toText(group?.pick),
        levels: this.effortLevels.filter((level) => levels.has(level)),
        levelsMode: levels.size > 0 ? "own" : "shared",
        routing: toText(group?.routing) || "smart",
        affinity: toText(group?.affinity),
        effort: toText(group?.effort) || "agent",
        classifier: {
          provider: toText(group?.classifier?.provider),
          model: toText(group?.classifier?.model),
        },
      }
    },

    ruleToDraft(rule) {
      const draft = emptyRule()
      if (!rule || typeof rule !== "object") return draft
      draft.use = toText(rule.use)
      draft.tokens = toText(rule.tokens)
      draft.images = booleanChoice(rule.images)
      draft.effort = toText(rule.effort)
      draft.agents = listOf(rule.agents)
        .map((agent) => toText(agent))
        .join(", ")
      draft.intent = toText(rule.intent)
      draft.compact = booleanChoice(rule.compact)
      if (rule.time && typeof rule.time === "object") {
        draft.timeEnabled = true
        draft.timeFrom = toText(rule.time.from)
        draft.timeTo = toText(rule.time.to)
        draft.timeDays = listOf(rule.time.days).map((day) => toText(day))
      }
      return draft
    },

    /** A draft row as a stored rule: unset conditions are left out entirely. */
    draftToRule(draft) {
      const rule = { use: toText(draft.use).trim() }
      const tokens = toText(draft.tokens).trim()
      if (tokens !== "") rule.tokens = Number(tokens)
      if (draft.images === "true") rule.images = true
      if (draft.images === "false") rule.images = false
      if (draft.effort) rule.effort = draft.effort
      const agents = toText(draft.agents)
        .split(",")
        .map((agent) => agent.trim())
        .filter((agent) => agent !== "")
      if (agents.length > 0) rule.agents = agents
      const intent = toText(draft.intent).trim()
      if (intent !== "") rule.intent = intent
      if (draft.compact === "true") rule.compact = true
      if (draft.compact === "false") rule.compact = false
      if (draft.timeEnabled) {
        const time = {
          from: toText(draft.timeFrom).trim(),
          to: toText(draft.timeTo).trim(),
        }
        if (listOf(draft.timeDays).length > 0) time.days = [...draft.timeDays]
        rule.time = time
      }
      return rule
    },

    /** Whether a draft rule constrains anything at all. */
    ruleHasCondition(rule) {
      return (
        toText(rule.tokens).trim() !== ""
        || rule.images !== ""
        || rule.effort !== ""
        || toText(rule.agents).trim() !== ""
        || toText(rule.intent).trim() !== ""
        || rule.compact !== ""
        || rule.timeEnabled === true
      )
    },

    // ── save / delete ────────────────────────────────────────────────

    /**
     * Every problem a mirror of the store's validation can find, so an
     * unusable group is caught before a round-trip. Messages name the rule
     * number the way a user counts rules (first rule is 1).
     */
    validateDraft() {
      const problems = []
      const id = (
        this.editingId ?
          toText(this.form.id).trim() || this.editingId
        : toText(this.form.id).trim() || this.computedId).trim()
      if (id === "") {
        problems.push(
          this.t("routingGroups.problem.required", {
            field: this.t("routingGroups.id"),
          }),
        )
      } else if (/[\s/]/.test(id)) {
        problems.push(this.t("routingGroups.problem.idShape", { value: id }))
      }
      if (toText(this.form.name).trim() === "") {
        problems.push(
          this.t("routingGroups.problem.required", {
            field: this.t("routingGroups.name"),
          }),
        )
      }

      const members = this.form.members
        .map((raw) => toText(raw).trim())
        .filter((member) => member !== "")
      if (members.length === 0) {
        problems.push(this.t("routingGroups.problem.membersRequired"))
      }
      const seen = new Set()
      for (const member of members) {
        const bare = bareMember(member)
        if (!isMemberShape(bare)) {
          problems.push(
            this.t("routingGroups.problem.memberShape", { value: member }),
          )
        }
        if (seen.has(bare)) {
          problems.push(
            this.t("routingGroups.problem.duplicateMember", { value: member }),
          )
        }
        seen.add(bare)
      }

      // `pick` and a rule's `use` may only name a member this group has,
      // compared without the `:effort` / `:fast` suffixes.
      const choices = [...seen]
      this.form.rules.forEach((rule, index) => {
        const number = index + 1
        const use = toText(rule.use).trim()
        if (use === "") {
          problems.push(
            this.t("routingGroups.problem.ruleUse", { index: number }),
          )
        } else if (!choices.includes(bareMember(use))) {
          problems.push(
            this.t("routingGroups.problem.ruleNotMember", {
              index: number,
              value: use,
            }),
          )
        }
        const tokens = toText(rule.tokens).trim()
        if (tokens !== "" && !Number.isFinite(Number(tokens))) {
          problems.push(
            this.t("routingGroups.problem.tokens", { index: number }),
          )
        }
        if (!this.ruleHasCondition(rule)) {
          problems.push(
            this.t("routingGroups.problem.noConditions", { index: number }),
          )
        }
        if (rule.timeEnabled) {
          const from = toText(rule.timeFrom).trim()
          const to = toText(rule.timeTo).trim()
          if (!TIME_PATTERN.test(from) || !TIME_PATTERN.test(to)) {
            problems.push(
              this.t("routingGroups.problem.timeShape", { index: number }),
            )
          }
        }
      })

      const pick = toText(this.form.pick).trim()
      if (pick !== "" && !choices.includes(bareMember(pick))) {
        problems.push(
          this.t("routingGroups.problem.pickNotMember", { value: pick }),
        )
      }

      if (this.hasClassifierNeed) {
        const provider = toText(this.form.classifier?.provider).trim()
        const model = toText(this.form.classifier?.model).trim()
        if ((provider === "") !== (model === "")) {
          problems.push(this.t("routingGroups.problem.classifier"))
        }
        if (
          toText(this.form.effort).trim() === "auto"
          && (provider === "" || model === "")
        ) {
          problems.push(this.t("routingGroups.problem.effortAutoClassifier"))
        }
      }

      return problems
    },

    /** The request body: what the store will validate, canonicalized. */
    buildPayload() {
      const members = []
      const fast = []
      this.form.members.forEach((raw, index) => {
        const member = toText(raw).trim()
        if (member === "") return
        members.push(member)
        if (this.form.fastFlags[index] === true) fast.push(member)
      })

      const id = (
        this.editingId ?
          toText(this.form.id).trim() || this.editingId
        : toText(this.form.id).trim() || this.computedId).trim()

      const group = {
        id,
        name: toText(this.form.name).trim() || id,
        members,
        rules: this.form.rules.map((rule) => this.draftToRule(rule)),
        expose: this.form.expose === true,
      }

      const pick = toText(this.form.pick).trim()
      if (pick !== "") group.pick = pick
      if (fast.length > 0) group.fast = fast

      if (this.form.levelsMode === "own") {
        const levels = this.effortLevels.filter((level) =>
          listOf(this.form.levels).includes(level),
        )
        if (levels.length > 0) group.levels = levels
      }

      if (this.hasClassifierNeed) {
        const provider = toText(this.form.classifier?.provider).trim()
        const model = toText(this.form.classifier?.model).trim()
        if (provider !== "" && model !== "") {
          group.classifier = { provider, model }
        }
      }

      const routing = toText(this.form.routing).trim()
      if (routing !== "") group.routing = routing
      const affinity = toText(this.form.affinity).trim()
      if (affinity !== "") group.affinity = affinity
      const effort = toText(this.form.effort).trim()
      if (effort !== "") group.effort = effort
      return group
    },

    async save() {
      const problems = this.validateDraft()
      if (problems.length > 0) {
        this.showToast(
          `${this.t("routingGroups.invalid")}${problems.join("; ")}`,
          "error",
        )
        return
      }

      this.saving = true
      try {
        await API.routingGroups.upsert(this.buildPayload())
        this.closeModal()
        this.showToast(this.t("routingGroups.saved"), "success")
        await this.load()
      } catch (error) {
        this.showToast(error.message, "error")
      } finally {
        this.saving = false
      }
    },

    async remove(group) {
      const name = toText(group?.name) || toText(group?.id)
      if (
        !globalThis.confirm(this.t("routingGroups.deleteConfirm", { name }))
      ) {
        return
      }
      try {
        await API.routingGroups.delete(group.id)
        this.showToast(this.t("routingGroups.deleted"), "success")
        await this.load()
      } catch (error) {
        this.showToast(error.message, "error")
      }
    },

    // ── repeatable rows ──────────────────────────────────────────────

    addMember() {
      this.form.members.push("")
      this.form.fastFlags.push(false)
    },

    /** Whether a member is already in the form (compared without suffixes). */
    isMemberAdded(member) {
      const bare = bareMember(member)
      return this.form.members.some((entry) => bareMember(entry) === bare)
    },

    /** The lucide icon for a provider id, with a generic fallback. */
    providerIcon(provider) {
      return this.providerIcons[toText(provider).toLowerCase()] || "box"
    },

    /** Toggle the picker popover; the rail keeps its selection. */
    openMemberPicker() {
      this.memberPickerOpen = !this.memberPickerOpen
      if (this.memberPickerOpen) {
        this.memberSearch = ""
        this.$nextTick(() => {
          lucide.createIcons()
          if (this.$refs.pickerSearchInput) {
            this.$refs.pickerSearchInput.focus()
          }
        })
      }
    },

    /** A context window as a compact badge: 1000000 → "1M", 200000 → "200k". */
    formatContext(value) {
      const tokens = Number(value || 0)
      if (!Number.isFinite(tokens) || tokens <= 0) return ""
      if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`
      if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`
      return String(tokens)
    },

    /** Append a member from the picker list or the raw search box. */
    addMemberFromPicker(member) {
      const value = toText(member).trim()
      if (value === "") return
      if (!this.form.members.includes(value)) {
        this.form.members.push(value)
        this.form.fastFlags.push(false)
        this.memberPickerOpen = false
        this.memberSearch = ""
      } else {
        this.showToast(
          this.t("routingGroups.problem.duplicateMember", { value }),
          "warning",
        )
      }
    },

    /** Add whatever the search box holds, as a raw `provider/model` id. */
    pickerAddRaw() {
      const member = this.rawMemberCandidate
      if (member === "") return
      this.addMemberFromPicker(member)
      this.memberSearch = ""
    },

    /**
     * Repeatable rows use `:checked` + `@change` rather than binding a
     * checkbox group: the lists live in objects inside `x-for`, and one
     * explicit toggle keeps the state readable from the markup alone.
     */
    toggleFast(index) {
      this.form.fastFlags[index] = this.form.fastFlags[index] !== true
    },

    toggleLevel(level) {
      const index = this.form.levels.indexOf(level)
      if (index >= 0) this.form.levels.splice(index, 1)
      else this.form.levels.push(level)
    },

    isLevelSelected(level) {
      return listOf(this.form.levels).includes(level)
    },

    toggleRuleDay(rule, day) {
      const index = rule.timeDays.indexOf(day)
      if (index >= 0) rule.timeDays.splice(index, 1)
      else rule.timeDays.push(day)
    },

    ruleHasDay(rule, day) {
      return rule.timeDays.includes(day)
    },

    removeMember(index) {
      this.form.members.splice(index, 1)
      this.form.fastFlags.splice(index, 1)
      // A removed member cannot stay the default pick or rule target.
      const choices = this.memberChoices()
      const pick = toText(this.form.pick).trim()
      if (pick !== "" && !choices.includes(pick)) {
        this.form.pick = ""
      }
      this.form.rules = this.form.rules.filter((r) =>
        choices.includes(bareMember(r.use)),
      )
    },

    addRule() {
      this.form.rules.push(emptyRule())
    },

    removeRule(index) {
      this.form.rules.splice(index, 1)
    },

    /** Rules are ordered and the first match wins, so order is editable. */
    moveRule(index, offset) {
      const target = index + offset
      if (target < 0 || target >= this.form.rules.length) return
      const [rule] = this.form.rules.splice(index, 1)
      this.form.rules.splice(target, 0, rule)
    },

    async copy(text) {
      try {
        await navigator.clipboard.writeText(toText(text))
        this.showToast(this.t("copySuccess"), "success")
      } catch {
        this.showToast(this.t("routingGroups.copyFailed"), "error")
      }
    },
  }
}
