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

describe("channels table row disclosure", () => {
  const section = () => {
    const html = readFileSync("pages/partials/performance-detail.html", "utf8")
    return html.slice(
      html.indexOf("<!-- 3. 主体内容 TAB 1"),
      html.indexOf("<!-- 4. 主体内容 TAB 2"),
    )
  }

  test("exposes expand/collapse as a real button inside the model column", () => {
    const html = section()
    const anchor = html.indexOf("展开控件与整行点击等效")
    expect(anchor).toBeGreaterThan(-1)
    const button = html.slice(anchor, html.indexOf("</button>", anchor))
    // 键盘/读屏可达：真 button + aria 状态，而不是只能靠冒泡到整行的装饰图标
    expect(button).toContain("<button")
    expect(button).toContain('data-lucide="chevron-down"')
    expect(button).toContain(':aria-expanded="isRowExpanded(getRowKey(row))"')
    // 自己处理点击必须 stop，否则会和整行点击叠成两次 toggle
    expect(button).toContain('@click.stop="toggleRow(getRowKey(row))"')
    // 展开控件不能跑回最右侧：模型名必须先于它出现
    expect(html.indexOf('x-text="row.model"')).toBeGreaterThan(anchor)
  })

  test("keeps a single set of 7 columns without a decorative 分析 column", () => {
    const html = section()
    const thead = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"))
    expect(thead.match(/<th\b/g)).toHaveLength(7)
    expect(thead).not.toContain(">分析</th>")

    const rowStart = html.indexOf('@click="toggleRow')
    const row = html.slice(
      html.lastIndexOf("<tr", rowStart),
      html.indexOf("</tr>", rowStart),
    )
    expect(row.match(/<td\b/g)).toHaveLength(7)

    // 详情面板的跨列数必须跟上表头
    expect(html).toContain('<td colspan="7"')
    expect(html).not.toContain('colspan="8"')
  })
})

describe("incremental admin icons", () => {
  test("saving a connection from a modal renders the new card's action icons", async () => {
    const frames: Array<() => void> = []
    const icon = {
      localName: "i",
      getAttribute: () => "pencil",
      setAttribute: () => {},
    }
    const root = {
      isConnected: true,
      contains: () => false,
      querySelectorAll: () => [icon],
    }
    // Alpine's $el is the clicked modal button, not the connections component.
    const button = {
      isConnected: true,
      contains: () => false,
      querySelectorAll: () => [],
    }
    const connection = { id: "new-connection" }
    const view = runInNewContext(
      readFileSync("pages/js/admin-icons.js", "utf8")
        + "\n"
        + readFileSync("pages/js/views/connections.js", "utf8")
        + "\nconnectionsView()",
      {
        ViewHelpers: { showToast: () => {} },
        API: {
          providerConnections: {
            create: async () => ({ connection }),
            list: async () => ({ connections: [connection] }),
            presets: async () => ({ presets: [] }),
          },
        },
        requestAnimationFrame: (callback: () => void) => frames.push(callback),
        lucide: {
          createIcons(options: {
            root: { querySelectorAll(selector: string): Array<typeof icon> }
          }) {
            for (const node of options.root.querySelectorAll("[data-lucide]"))
              node.localName = "svg"
          },
        },
      },
    ) as {
      $root: typeof root
      $el: typeof button
      $nextTick(callback: () => void): void
      connForm: { name: string; baseUrl: string }
      connections: Array<typeof connection>
      showConnModal: boolean
      saveConn(): Promise<void>
    }
    view.$root = root
    view.$el = button
    view.$nextTick = (callback) => callback()
    view.connForm.name = "New endpoint"
    view.connForm.baseUrl = "https://example.invalid/v1"
    view.showConnModal = true
    await view.saveConn()
    for (const frame of frames) frame()
    expect(view.connections).toEqual([connection])
    expect(view.showConnModal).toBe(false)
    expect(icon.localName).toBe("svg")
  })

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
