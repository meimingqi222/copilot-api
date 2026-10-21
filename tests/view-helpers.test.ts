import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface BrandIconHelpers {
  resolveBrandIconName(provider: string, modelId: string): string
  brandIconHtml(provider: string, modelId: string, extraClass?: string): string
}

const helpers: BrandIconHelpers = runInNewContext(
  readFileSync("pages/js/view-helpers.js", "utf8") + "\nViewHelpers",
)

interface AliasModel {
  publicId: string
  aliases?: string[]
}

type AliasView = Record<string, unknown> & {
  showToast(message: string, type: string): void
  $nextTick(callback: () => void): void
  add(model: AliasModel): Promise<void>
  remove(model: AliasModel, alias: string): Promise<void>
  toggle(model: AliasModel): void
  rename(model: AliasModel): void
}

for (const config of [
  {
    name: "accounts",
    api: "accounts",
    prefix: "accountModels",
    add: "addAccountModelAlias",
    remove: "removeAccountModelAlias",
    toggle: "toggleAccountAliasEditor",
    rename: "startAccountRename",
  },
  {
    name: "connections",
    api: "providerConnections",
    prefix: "modelManager",
    add: "addModelAlias",
    remove: "removeModelAlias",
    toggle: "toggleAliasEditor",
    rename: "startRenameModel",
  },
]) {
  describe(`${config.name} model alias entry`, () => {
    function setup() {
      const calls: unknown[][] = []
      const toasts: string[][] = []
      let failure: Error | undefined
      let finish: (() => void) | undefined
      const view = runInNewContext(
        readFileSync("pages/js/view-helpers.js", "utf8")
          + readFileSync(`pages/js/views/${config.name}.js`, "utf8")
          + `\n${config.name}View()`,
        {
          API: {
            [config.api]: {
              async updateModel(...args: unknown[]) {
                calls.push(args)
                if (failure) throw failure
                await new Promise<void>((resolve) => {
                  finish = resolve
                })
              },
            },
          },
          I18n: { t: (key: string) => `translated:${key}` },
          refreshAdminIcons: () => {},
        },
      ) as AliasView
      view.showToast = (...args) => {
        toasts.push(args)
      }
      view.$nextTick = () => {}
      view[`${config.prefix}Conn`] = { id: "connection" }
      view.add = view[config.add] as AliasView["add"]
      view.remove = view[config.remove] as AliasView["remove"]
      view.toggle = view[config.toggle] as AliasView["toggle"]
      view.rename = view[config.rename] as AliasView["rename"]
      return {
        view,
        calls,
        toasts,
        fail: (error: Error) => {
          failure = error
        },
        finish: () => finish?.(),
      }
    }

    const input = `${config.prefix}AliasInput`

    test("deduplicates case-insensitively and ignores empty/missing connection", async () => {
      const { view, calls } = setup()
      const model = { publicId: "model", aliases: ["Existing"] }
      view[input] = " existing "
      await view.add(model)
      expect(view[input]).toBe("")
      view[input] = "   "
      await view.add(model)
      expect(view[input]).toBe("   ")
      view[`${config.prefix}Conn`] = null
      view[input] = "new"
      await view.add(model)
      await view.remove(model, "Existing")
      expect(view[input]).toBe("new")
      expect(calls).toEqual([])
      expect(model.aliases).toEqual(["Existing"])
    })

    test("commits trimmed aliases and clears input only after save succeeds", async () => {
      const { view, calls, finish, toasts } = setup()
      const model: AliasModel = { publicId: "model" }
      view[input] = " NewAlias "
      const pending = view.add(model)
      expect(model.aliases).toBeUndefined()
      expect(view[input]).toBe(" NewAlias ")
      expect(calls).toEqual([
        ["connection", "model", { aliases: ["NewAlias"] }],
      ])
      finish()
      await pending
      expect(model.aliases).toEqual(["NewAlias"])
      expect(view[input]).toBe("")
      expect(toasts).toEqual([])
    })

    for (const message of ["upstream failed", ""]) {
      test(`failed add/delete preserves state (${message || "I18n fallback"})`, async () => {
        const { view, fail, toasts } = setup()
        fail(new Error(message))
        const model = { publicId: "model", aliases: ["Keep"] }
        view[input] = " New "
        await view.add(model)
        await view.remove(model, "Keep")
        expect(model.aliases).toEqual(["Keep"])
        expect(view[input]).toBe(" New ")
        expect(toasts).toEqual(
          Array(2).fill([message || "translated:error.update", "error"]),
        )
      })
    }

    test("deletion is exact-case and commits only after successful save", async () => {
      const { view, calls, finish } = setup()
      const model = { publicId: "model", aliases: ["Alias", "alias", "Other"] }
      view[input] = "untouched"
      const pending = view.remove(model, "Alias")
      expect(model.aliases).toEqual(["Alias", "alias", "Other"])
      expect(calls).toEqual([
        ["connection", "model", { aliases: ["alias", "Other"] }],
      ])
      finish()
      await pending
      expect(model.aliases).toEqual(["alias", "Other"])
      expect(view[input]).toBe("untouched")
    })

    test("alias editor and rename remain mutually exclusive", () => {
      const { view } = setup()
      const model = { publicId: "model" }
      view.rename(model)
      view.toggle(model)
      expect(view[`${config.prefix}EditingId`]).toBeNull()
      expect(view[`${config.prefix}AliasFor`]).toBe("model")
      view[input] = "draft"
      view.toggle(model)
      expect(view[`${config.prefix}AliasFor`]).toBeNull()
      expect(view[input]).toBe("")
      view.toggle(model)
      view.rename(model)
      expect(view[`${config.prefix}AliasFor`]).toBeNull()
      expect(view[input]).toBe("")
    })
  })
}

describe("provider brand icons", () => {
  test("Windsurf uses its own bundled icon in every shared view", () => {
    expect(helpers.resolveBrandIconName("windsurf", "")).toBe("windsurf")
    expect(helpers.resolveBrandIconName(" Windsurf ", "gemini-test")).toBe(
      "windsurf",
    )
    expect(existsSync("pages/icons/windsurf.svg")).toBe(true)
    expect(helpers.brandIconHtml("windsurf", "", "w-4 h-4")).toContain(
      "/admin/static/icons/windsurf.svg",
    )
    expect(helpers.brandIconHtml("windsurf", "")).not.toContain("antigravity")
  })

  test("Antigravity retains its own color icon", () => {
    expect(helpers.resolveBrandIconName("antigravity", "")).toBe(
      "antigravity-color",
    )
    expect(helpers.brandIconHtml("antigravity", "")).toContain(
      "/admin/static/icons/antigravity-color.svg",
    )
  })

  test("Codebuff uses its own PNG mark, not the codex icon", () => {
    expect(helpers.resolveBrandIconName("codebuff", "")).toBe("codebuff")
    expect(existsSync("pages/icons/codebuff.png")).toBe(true)
    expect(helpers.brandIconHtml("codebuff", "")).toContain(
      "/admin/static/icons/codebuff.png",
    )
    expect(helpers.brandIconHtml("codebuff", "")).not.toContain("codex-color")
  })

  test("LobsterAI resolves to its own PNG mark instead of the fallback", () => {
    expect(helpers.resolveBrandIconName("lobsterai", "")).toBe("lobsterai")
    expect(existsSync("pages/icons/lobsterai.png")).toBe(true)
    expect(helpers.brandIconHtml("lobsterai", "")).toContain(
      "/admin/static/icons/lobsterai.png",
    )
  })

  test("Mimo Claw resolves to its own color SVG icon", () => {
    expect(helpers.resolveBrandIconName("mimo-aistudio", "")).toBe(
      "mimoclaw-color",
    )
    expect(helpers.resolveBrandIconName("mimo", "")).toBe("mimoclaw-color")
    expect(helpers.resolveBrandIconName("mimo-claw", "")).toBe("mimoclaw-color")
    expect(existsSync("pages/icons/mimoclaw-color.svg")).toBe(true)
    expect(helpers.brandIconHtml("mimo-aistudio", "")).toContain(
      "/admin/static/icons/mimoclaw-color.svg",
    )
    expect(helpers.brandIconHtml("mimo-aistudio", "")).toContain("<img src=")
  })
})
