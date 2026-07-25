function modelAliasesView() {
  return {
    loading: false,
    aliases: [],
    showModal: false,
    editingId: null,
    previewModel: "",
    preview: null,
    form: {
      enabled: true,
      kind: "exact",
      from: "",
      to: "",
      exposeInModels: false,
      note: "",
      scope: "",
    },

    t(key, params) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) void Alpine.$data(app).lang
      return I18n.t(key, params)
    },

    showToast(message, type) {
      const app = document.querySelector("[x-data^=adminApp]")
      if (app) Alpine.$data(app).showToast(message, type)
    },

    async load() {
      this.loading = true
      try {
        this.aliases = (await API.modelAliases.list()).aliases || []
      } catch (error) {
        this.showToast(error.message, "error")
      } finally {
        this.loading = false
      }
    },

    openCreate() {
      this.editingId = null
      this.form = {
        enabled: true,
        kind: "exact",
        from: "",
        to: "",
        exposeInModels: false,
        note: "",
        scope: "",
      }
      this.showModal = true
    },

    openEdit(alias) {
      this.editingId = alias.id
      this.form = {
        enabled: alias.enabled,
        kind: alias.kind,
        from: alias.from,
        to: alias.to,
        exposeInModels: alias.exposeInModels,
        note: alias.note || "",
        scope: alias.scope ?
          JSON.stringify(alias.scope)
        : "",
      }
      this.showModal = true
    },

    parseScope() {
      if (!this.form.scope.trim()) return undefined
      return JSON.parse(this.form.scope)
    },

    async save() {
      try {
        const payload = {
          enabled: this.form.enabled,
          kind: this.form.kind,
          from: this.form.from,
          to: this.form.to,
          exposeInModels: this.form.exposeInModels,
          note: this.form.note,
          scope: this.parseScope(),
        }
        if (this.editingId) {
          await API.modelAliases.update(this.editingId, payload)
        } else {
          await API.modelAliases.create(payload)
        }
        this.showModal = false
        this.showToast(this.t("modelAliases.saved"), "success")
        await this.load()
      } catch (error) {
        this.showToast(error.message, "error")
      }
    },

    async remove(alias) {
      if (!globalThis.confirm(this.t("modelAliases.deleteConfirm"))) return
      try {
        await API.modelAliases.delete(alias.id)
        await this.load()
      } catch (error) {
        this.showToast(error.message, "error")
      }
    },

    async resolve() {
      if (!this.previewModel.trim()) {
        this.preview = null
        return
      }
      try {
        this.preview = await API.modelAliases.resolve(this.previewModel)
      } catch (error) {
        this.showToast(error.message, "error")
      }
    },
  }
}
