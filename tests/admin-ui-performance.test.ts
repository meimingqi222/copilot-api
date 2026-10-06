import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

describe("admin view lifecycle", () => {
  test("trace stream and ticker stop offscreen and resume with a fresh snapshot", () => {
    const document = { hidden: false }
    let opened = 0
    let closed = 0
    let snapshots = 0
    const timers = new Set<number>()
    const view = runInNewContext(
      readFileSync("pages/js/views/traces.js", "utf8") + "\ntracesView()",
      {
        ViewHelpers: {},
        document,
        setInterval: () => {
          timers.add(1)
          return 1
        },
        clearInterval: (id: number) => timers.delete(id),
      },
    ) as {
      currentView: string
      source: object | null
      paused: boolean
      load(): void
      connect(): void
      disconnect(): void
      clearFlights(): void
      stopReplay(): void
      refreshStage(): void
      syncActivity(): void
    }
    view.currentView = "traces"
    view.load = () => {
      snapshots++
    }
    view.connect = () => {
      opened++
      view.source = {}
    }
    view.disconnect = () => {
      if (view.source) closed++
      view.source = null
    }
    view.clearFlights = view.stopReplay = view.refreshStage = () => {}
    view.syncActivity()
    view.syncActivity()
    expect(opened).toBe(1)
    expect(timers.size).toBe(1)
    view.currentView = "performance"
    view.syncActivity()
    expect(closed).toBe(1)
    expect(timers.size).toBe(0)
    view.currentView = "traces"
    document.hidden = true
    view.syncActivity()
    expect(opened).toBe(1)
    document.hidden = false
    view.syncActivity()
    expect(opened).toBe(2)
    expect(snapshots).toBe(2)
    expect(timers.size).toBe(1)
    view.paused = true
    view.syncActivity()
    expect(closed).toBe(2)
  })

  test("Alpine auto-init is not invoked a second time by HTML", () => {
    const html = readFileSync("pages/index.html", "utf8")
    expect(html).not.toMatch(/x-init="init\(\)/)
  })

  test("views mount only after their first authenticated visit", () => {
    const html = readFileSync("pages/index.html", "utf8")
    const views = ["dashboard", "usage", "quotas", "performance", "traces"]
    for (const view of views) {
      expect(html).toContain(`x-if="initialized && visitedViews['${view}']"`)
    }
  })
})

describe("incremental admin icons", () => {
  test("coalesces refreshes and preserves unchanged SVG nodes and bindings", () => {
    const frames: Array<() => void> = []
    let replacements = 0
    const icon = (name: string, tag = "i") => ({
      localName: tag,
      attributes: new Map([
        ["data-lucide", name],
        [":class", "statusClass"],
      ]),
      getAttribute(key: string) {
        return this.attributes.get(key) ?? null
      },
      setAttribute(key: string, value: string) {
        this.attributes.set(key, value)
      },
    })
    const root = {
      isConnected: true,
      nodes: [icon("check")],
      contains: (other: unknown) => other === root,
      querySelectorAll: () => root.nodes,
    }
    const refresh: (root: unknown) => void = runInNewContext(
      readFileSync("pages/js/admin-icons.js", "utf8") + "\nrefreshAdminIcons",
      {
        document: root,
        requestAnimationFrame: (callback: () => void) => frames.push(callback),
        lucide: {
          createIcons(options: {
            root: { querySelectorAll(selector: string): typeof root.nodes }
          }) {
            for (const node of options.root.querySelectorAll("[data-lucide]")) {
              replacements++
              root.nodes[root.nodes.indexOf(node)] = {
                ...node,
                localName: "svg",
                attributes: new Map(node.attributes),
              }
            }
          },
        },
      },
    )
    refresh(root)
    refresh(root)
    expect(frames).toHaveLength(1)
    frames.shift()!()
    const rendered = root.nodes[0]
    expect(rendered.getAttribute(":class")).toBe("statusClass")
    for (let i = 0; i < 100; i++) refresh(root)
    frames.shift()!()
    expect(root.nodes[0]).toBe(rendered)
    expect(replacements).toBe(1)
    rendered.setAttribute("data-lucide", "x")
    refresh(root)
    frames.shift()!()
    expect(root.nodes[0]).not.toBe(rendered)
    expect(root.nodes[0].getAttribute("data-lucide")).toBe("x")
    expect(replacements).toBe(2)
    root.nodes.push(icon("plus"))
    refresh(root)
    frames.shift()!()
    expect(replacements).toBe(3)
  })
})
