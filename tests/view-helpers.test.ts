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
})
