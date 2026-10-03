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
