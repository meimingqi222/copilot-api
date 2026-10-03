/**
 * 只跑受本次改动影响的测试。
 *
 * 用法：
 *   bun run test:affected              # 相对 HEAD 的未提交改动（含 untracked）
 *   bun run test:affected --all        # 全量
 *   bun run test:affected <文件...>     # 显式指定改动文件（调试/CI）
 *   bun run test:affected --print      # 只打印选中的测试，不执行
 *
 * 命中规则（宽进，宁多勿漏）：
 *   1. 直接依赖：tests/*.test.ts import 了改动的 src 文件；
 *   2. 命名回退：改动文件的 stem / 父目录名出现在测试文件名里
 *      （qoder/endpoints.ts → *qoder*.test.ts）；
 *   3. 共享基建：provider-config / builtins / flows / provider-connections
 *      这类"谁都 import"的文件变了，跑核心回归包而不是逐条解析
 *      （逐条解析几乎全中，直接挑覆盖模块注册与 OAuth 主链路的一小包）。
 *
 * 只改 docs / pages / *.md / 脚本时输出提示并退出 0。
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TESTS_DIR = path.join(ROOT, "tests")

// 共享基建：变了就跑核心回归包（见文件头注释）。
const INFRA_PREFIXES = [
  "src/lib/provider-config.ts",
  "src/lib/provider-definitions.ts",
  "src/lib/provider-metadata.ts",
  "src/lib/provider-descriptors/",
  "src/lib/provider-connections/",
  "src/lib/route-target/",
  "src/lib/state.ts",
  "src/services/providers/builtins.ts",
  "src/services/providers/module.ts",
  "src/services/providers/registry.ts",
  "src/services/oauth/flows.ts",
  "src/services/oauth/strategy-types.ts",
  "src/services/oauth/provider-strategies.ts",
  "src/services/oauth/refresh-strategies.ts",
  "src/services/protocols/types.ts",
  "src/server.ts",
]

const CORE_PACK = [
  "tests/provider-modules.test.ts",
  "tests/provider-contributions.test.ts",
  "tests/provider-presentation.test.ts",
  "tests/provider-auth-update.test.ts",
  "tests/oauth-smoke.test.ts",
]

// stem 太泛会导致满屏误报（index/types/utils/state 到处都是）。
const NAME_STOPWORDS = new Set([
  "index",
  "types",
  "type",
  "utils",
  "util",
  "state",
  "shared",
  "helpers",
  "helper",
  "fetch",
  "error",
  "client",
  "server",
  "router",
  "routes",
  "api",
  "lib",
  "src",
  "main",
  "test",
  "tests",
  "models",
  "model",
])

const NO_TEST_PREFIXES = ["docs/", "pages/", ".agents/", "temp/", "scripts/"]
const NO_TEST_SUFFIXES = [
  ".md",
  ".json",
  ".html",
  ".css",
  ".svg",
  ".toml",
  ".yaml",
  ".yml",
]

function sh(cmd: string, args: Array<string>): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" })
  return r.status === 0 ? (r.stdout ?? "") : ""
}

/** 相对 HEAD 的未提交改动 + untracked。 */
function changedFiles(): Array<string> {
  const out = new Set<string>()
  for (const line of sh("git", ["diff", "--name-only", "HEAD"]).split("\n")) {
    const p = line.trim()
    if (p) out.add(p.replaceAll("\\", "/"))
  }
  for (const line of sh("git", ["ls-files", "-o", "--exclude-standard"]).split(
    "\n",
  )) {
    const p = line.trim()
    if (p) out.add(p.replaceAll("\\", "/"))
  }
  return [...out]
}

function listTestFiles(): Array<string> {
  const out: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".test.ts")) out.push(full)
    }
  }
  walk(TESTS_DIR)
  return out
}

const IMPORT_RE =
  /(?:import|export)[^"']*?from\s+["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g

/** 测试文件 import 的仓库内文件（~/x → src/x，相对路径按 importer 目录解析）。 */
function testDeps(file: string): Set<string> {
  const deps = new Set<string>()
  const text = fs.readFileSync(file, "utf8")
  const dir = path.dirname(file)
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    let abs: string | undefined
    if (spec.startsWith("~/")) {
      abs = path.join(ROOT, "src", spec.slice(2))
    } else if (spec.startsWith(".")) {
      abs = path.resolve(dir, spec)
    } else {
      continue
    }
    for (const cand of [
      abs,
      `${abs}.ts`,
      `${abs}.tsx`,
      path.join(abs, "index.ts"),
    ]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        deps.add(path.relative(ROOT, cand).replaceAll("\\", "/"))
        break
      }
    }
  }
  return deps
}

function stemTokens(rel: string): Array<string> {
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "")
  const dir = path.posix.dirname(rel).split("/").filter(Boolean)
  const parent = dir.length > 0 ? dir[dir.length - 1]! : ""
  return [...new Set([base, parent])].filter(
    (t) => t.length >= 3 && !NAME_STOPWORDS.has(t),
  )
}

function main(): void {
  const argv = process.argv.slice(2)
  const printOnly = argv.includes("--print") || argv.includes("--dry")
  if (argv.includes("--all")) {
    console.log("[test:affected] --all：跑全量。")
    run(["bun", "test"], printOnly)
    return
  }
  const explicit = argv.filter((a) => !a.startsWith("--"))
  const changed =
    explicit.length > 0 ?
      explicit.map((p) => p.replaceAll("\\", "/"))
    : changedFiles()

  if (changed.length === 0) {
    console.log("[test:affected] 没有检测到改动，无需跑测试。")
    return
  }

  const meaningful = changed.filter(
    (p) =>
      !NO_TEST_PREFIXES.some((x) => p.startsWith(x))
      && !NO_TEST_SUFFIXES.some((x) => p.endsWith(x)),
  )
  if (meaningful.length === 0) {
    console.log(
      `[test:affected] 改动 ${changed.length} 个文件，但全是文档/页面/脚本，跳过测试。`,
    )
    return
  }

  // src → tests 的反向依赖索引。
  const testFiles = listTestFiles()
  const depIndex = new Map<string, Array<string>>() // src rel → tests
  const depsByTest = new Map<string, Set<string>>()
  for (const file of testFiles) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/")
    const deps = testDeps(file)
    depsByTest.set(rel, deps)
    for (const dep of deps) {
      const list = depIndex.get(dep) ?? []
      list.push(rel)
      depIndex.set(dep, list)
    }
  }

  const selected = new Set<string>()
  const reasons = new Map<string, Array<string>>()
  const note = (test: string, why: string) => {
    selected.add(test)
    const list = reasons.get(test) ?? []
    list.push(why)
    reasons.set(test, list)
  }

  let infraHit = false
  for (const rel of meaningful) {
    if (rel.startsWith("tests/") && rel.endsWith(".test.ts")) {
      note(rel, "自身改动")
      continue
    }
    if (rel.startsWith("tests/")) {
      // 测试辅助文件（helpers/fixtures）：找 import 它的测试。
      for (const [test, deps] of depsByTest) {
        if (deps.has(rel)) note(test, `import 了 ${rel}`)
      }
      continue
    }
    if (INFRA_PREFIXES.some((x) => rel.startsWith(x))) {
      infraHit = true
      continue
    }
    for (const test of depIndex.get(rel) ?? []) {
      note(test, `import 了 ${rel}`)
    }
    for (const token of stemTokens(rel)) {
      for (const file of testFiles) {
        const testRel = path.relative(ROOT, file).replaceAll("\\", "/")
        if (path.posix.basename(testRel).includes(token)) {
          note(testRel, `名字含 "${token}"`)
        }
      }
    }
  }

  if (infraHit) {
    for (const t of CORE_PACK) {
      if (fs.existsSync(path.join(ROOT, t)))
        note(t, "共享基建改动 → 核心回归包")
    }
  }

  const tests = [...selected].sort()
  if (tests.length === 0) {
    console.log(
      `[test:affected] ${meaningful.length} 个源码改动没有命中任何测试（无依赖边/名字关联）。`
        + ` 存疑时跑 bun run test:affected -- --all`,
    )
    return
  }

  console.log(
    `[test:affected] ${changed.length} 个改动 → ${tests.length} 个测试文件：`,
  )
  for (const t of tests) {
    console.log(`  ${t}  (${(reasons.get(t) ?? []).join(", ")})`)
  }
  run(["bun", "test", ...tests], printOnly)
}

function run(cmd: Array<string>, printOnly: boolean): void {
  if (printOnly) {
    console.log(`[test:affected] dry-run：${cmd.join(" ")}`)
    return
  }
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: "inherit" })
  process.exit(r.status ?? 1)
}

main()
