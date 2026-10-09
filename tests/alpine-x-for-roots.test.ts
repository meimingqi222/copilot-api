import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"

/**
 * Alpine 的 x-for 只克隆模板的**第一个**根元素, 多出来的根元素会被静默丢弃
 * (仅在控制台留一句 warning), 于是“折叠箭头能转, 但展开后什么都没有”。
 *
 * 这个静态守卫遍历所有 admin 页面, 确保每个 x-for 模板只有一个根元素,
 * 并把该根元素里的内容原样渲染出来。
 */

/** 去掉 HTML 注释后, 按标签深度返回模板顶层元素名。 */
function topLevelTags(block: string): string[] {
  const source = block.replace(/<!--[\s\S]*?-->/g, "")
  const tags: string[] = []
  const tagRe =
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(source))) {
    const [, closing, name, , selfClosing] = match
    if (closing) {
      depth -= 1
      continue
    }
    if (depth === 0) tags.push(name)
    // <br/> 这类自闭合(或 void)标签不会加深层级
    if (
      !selfClosing
      && !/^(br|hr|img|input|meta|link|source|col|area|base|embed|param|track|wbr)$/i.test(
        name,
      )
    )
      depth += 1
  }
  return tags
}

/** 取出每个 `<template ... x-for ...> ... </template>` 的内部内容。 */
function xForTemplates(html: string): { opening: string; body: string }[] {
  const found: { opening: string; body: string }[] = []
  const openRe = /<template\b[^>]*\bx-for\b[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = openRe.exec(html))) {
    const bodyStart = match.index + match[0].length
    const templateRe = /<\/?template\b/g
    templateRe.lastIndex = bodyStart
    let depth = 1
    let bodyEnd = -1
    let inner: RegExpExecArray | null
    while ((inner = templateRe.exec(html))) {
      depth += inner[0].startsWith("</") ? -1 : 1
      if (depth === 0) {
        bodyEnd = inner.index
        break
      }
    }
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    found.push({ opening: match[0], body: html.slice(bodyStart, bodyEnd) })
  }
  return found
}

const adminPages = [
  "pages/index.html",
  "pages/login.html",
  "pages/setup.html",
  ...readdirSync("pages/partials").map((name) => `pages/partials/${name}`),
]

describe("Alpine x-for templates", () => {
  test("every x-for template has exactly one root element", () => {
    const offenders: string[] = []
    for (const path of adminPages) {
      const html = readFileSync(path, "utf8")
      for (const { opening, body } of xForTemplates(html)) {
        const roots = topLevelTags(body)
        if (roots.length !== 1) {
          offenders.push(`${path} ${opening.trim()} -> [${roots.join(", ")}]`)
        }
      }
    }
    // 多余根元素会被 Alpine 静默丢掉, 用户看到的就是“点了没反应”
    expect(offenders).toEqual([])
  })

  test("channel matrix renders the drill-down row inside the row loop", () => {
    const html = readFileSync("pages/partials/performance-detail.html", "utf8")
    const loop = xForTemplates(html).find(({ opening }) =>
      opening.includes('x-for="row in sortedDetails"'),
    )
    expect(loop).toBeDefined()
    const roots = topLevelTags(loop!.body)
    // 数据行与下钻详情行必须同处一个根元素内, 否则详情行不会进 DOM
    expect(roots).toEqual(["tbody"])
    expect(loop!.body).toContain('x-show="isRowExpanded(getRowKey(row))"')
    expect(loop!.body).toContain('@click="toggleRow(getRowKey(row))"')
  })
})
