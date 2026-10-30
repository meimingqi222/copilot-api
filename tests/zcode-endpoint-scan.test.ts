import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createZcodeApiPathScanner,
  diffZcodeEndpoints,
  extractZcodeApiPaths,
  isTrackedZcodePath,
  scanZcodeApiPathsInFile,
} from "~/services/zcode/endpoint-scan"

describe("zcode endpoint scan", () => {
  test("pulls /api/v1 paths out of a minified bundle", () => {
    const bundle = Buffer.from(
      'x=1;fetch("/api/v1/zcode-plan/billing/claim");'
        + "y=`/api/v1/marketing/touch?seq=`+n;"
        + 'z="/api/v1/client/configs",other="/api/v2/thing";',
      "latin1",
    )
    const paths = extractZcodeApiPaths(bundle)
    expect(paths).toContain("/api/v1/zcode-plan/billing/claim")
    expect(paths).toContain("/api/v1/marketing/touch")
    expect(paths).toContain("/api/v1/client/configs")
    expect(paths).not.toContain("/api/v2/thing")
  })

  test("a path split across chunks is still found", () => {
    const scanner = createZcodeApiPathScanner()
    scanner.push(Buffer.from('fetch("/api/v1/zcode-', "latin1"))
    scanner.push(Buffer.from('plan/billing/balance")', "latin1"))
    expect(scanner.finish()).toContain("/api/v1/zcode-plan/billing/balance")
  })

  test("trailing punctuation is stripped", () => {
    const paths = extractZcodeApiPaths(
      Buffer.from('"/api/v1/marketing/touch/action",', "latin1"),
    )
    expect(paths).toEqual(["/api/v1/marketing/touch/action"])
  })

  test("only the volatile prefixes are tracked", () => {
    expect(isTrackedZcodePath("/api/v1/zcode-plan/billing/claim")).toBe(true)
    expect(isTrackedZcodePath("/api/v1/marketing/touch")).toBe(true)
    expect(isTrackedZcodePath("/api/v1/releases/electron/manifest")).toBe(true)
    // 业务端点不进快照：它们的增删与套餐投放无关。
    expect(isTrackedZcodePath("/api/v1/workspace/projects")).toBe(false)
  })

  test("the diff names what appeared and what disappeared", () => {
    const diff = diffZcodeEndpoints(
      ["/api/v1/marketing/touch", "/api/v1/zcode-plan/billing/preview"],
      ["/api/v1/marketing/touch", "/api/v1/zcode-plan/billing/gift"],
    )
    expect(diff.added).toEqual(["/api/v1/zcode-plan/billing/gift"])
    expect(diff.missing).toEqual(["/api/v1/zcode-plan/billing/preview"])
  })

  test("scanning a file reads past the first chunk", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "zcode-scan-")),
      "blob.bin",
    )
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.alloc(4096, 0x20),
        Buffer.from('"/api/v1/zcode-plan/billing/claim"', "latin1"),
      ]),
    )
    try {
      expect(scanZcodeApiPathsInFile(file, 512)).toContain(
        "/api/v1/zcode-plan/billing/claim",
      )
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})
