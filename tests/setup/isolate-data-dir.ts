/**
 * Bun test preload: redirect every PATHS entry to a per-process temp dir and
 * enable hard write guards against ~/.local/share/copilot-api.
 *
 * Loaded via bunfig.toml [test].preload — runs before test files import src.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ensurePaths, redirectPathsToDir } from "~/lib/paths"

process.env.COPILOT_API_TEST_ISOLATION = "1"
process.env.NODE_ENV = "test"

const testDataDir =
  process.env.COPILOT_API_DATA_DIR?.trim()
  || fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-test-"))

process.env.COPILOT_API_DATA_DIR = testDataDir
redirectPathsToDir(testDataDir)

// Best-effort seed empty data files so loaders don't touch production.
void ensurePaths().catch(() => {
  // Preload must not crash the suite if mkdir races; writes still guarded.
})

/**
 * The pristine `fetch`, snapshotted before any test file loads.
 *
 * Bun runs every test file in one process, so a file that patches
 * `globalThis.fetch` and forgets to restore it leaks into every file after it.
 * A file cannot defend itself by capturing `globalThis.fetch` at its own load
 * time — by then the value may already be another file's stub. Restoring this
 * snapshot in an `afterEach` is the only trustworthy reset.
 */
;(globalThis as unknown as { __realFetch?: typeof fetch }).__realFetch =
  globalThis.fetch
