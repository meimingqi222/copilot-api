import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

/**
 * admin 前端的本地资源全部带 `?v=` 版本号做缓存击穿, 静态路由又只发
 * `Cache-Control: no-cache, must-revalidate`(没有 ETag/Last-Modified),
 * 所以**版本号不变 = 浏览器继续跑旧文件**。
 *
 * `performance.js` 曾把 Chart.js 实例存进 Alpine 响应式状态, 导致走势图静默
 * 刷新时栈溢出 + `Cannot set properties of undefined (setting 'fullSize')`。
 * 修复提交只改了 JS 却忘了在 index.html 里提升版本号, 用户浏览器于是仍在执行
 * 旧文件(报错行号与修复前完全一致)。这里把"改了文件就必须提升版本号"变成断言。
 */

const html = readFileSync("pages/index.html", "utf8")

/** index.html 里引用的所有本地资源: /admin/static/** 与 partials/**.html */
function localAssets(): { attr: string; path: string; version: string }[] {
  const found: { attr: string; path: string; version: string }[] = []
  const re =
    /(?:src|href)="(\/admin\/static\/[^"?]+)(\?v=([^"]*))?"|data-partial="(partials\/[^"?]+)(\?v=([^"]*))?"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const path = match[1] ?? match[4]
    const version = match[3] ?? match[6]
    found.push({ attr: match[0], path, version: version ?? "" })
  }
  return found
}

/** "0.7.10" -> [0, 7, 10], 用于逐段数值比较 */
function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10))
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 磁盘上的真实路径: /admin/static/x -> pages/x, partials/x -> pages/partials/x */
function diskPath(assetPath: string): string {
  return `pages/${assetPath.replace(/^\/admin\/static\//, "")}`
}

describe("admin asset cache busting", () => {
  const assets = localAssets()

  test("index.html references local assets that exist on disk", () => {
    expect(assets.length).toBeGreaterThan(20)
    const missing = assets
      .filter(({ path }) => !existsSync(diskPath(path)))
      .map(({ path }) => path)
    expect(missing).toEqual([])
  })

  test("every local asset carries a ?v= version", () => {
    const unversioned = assets
      .filter(({ version }) => version === "")
      .map(({ attr }) => attr)
    // 没有版本号意味着 URL 永远不变, 改了文件也拿不到新代码
    expect(unversioned).toEqual([])
  })

  test("each asset is referenced with exactly one version", () => {
    const byPath = new Map<string, Set<string>>()
    for (const { path, version } of assets) {
      const versions = byPath.get(path) ?? new Set<string>()
      versions.add(version)
      byPath.set(path, versions)
    }
    const conflicting = [...byPath.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([path, versions]) => `${path} -> ${[...versions].join(", ")}`)
    expect(conflicting).toEqual([])
  })

  test("tracked assets stay ahead of their known-stale versions", () => {
    // 键 = 曾经"改了文件却忘了升版本号"的资源, 值 = 出事时的旧版本号。
    // 之后每次改动这些文件, 都必须把 index.html 里的版本号抬过该基线,
    // 否则浏览器会一直执行旧代码(页面报的错也就一直不消失)。
    const staleFloors: Record<string, string> = {
      // 0.7.9 是把 Chart.js 实例存进 Alpine 响应式状态、导致走势图静默刷新
      // 栈溢出 + `Cannot set properties of undefined (setting 'fullSize')` 的一版
      "js/views/performance.js": "0.7.10",
      "partials/performance-detail.html": "0.7.10",
      // 0.7.18 缺少 last1h/last6h 的实时范围文案, 新按钮会渲染成空白
      "js/i18n.js": "0.7.19",
    }
    for (const [suffix, floor] of Object.entries(staleFloors)) {
      const asset = assets.find(({ path }) => path.endsWith(suffix))
      expect(asset).toBeDefined()
      expect(compareVersions(asset!.version, floor)).toBeGreaterThanOrEqual(0)
    }
  })
})
