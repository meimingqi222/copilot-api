/**
 * Shared fixtures for the Claude CLI transport tests.
 *
 * CI has no Claude Code installed, so the bridge is driven against a fake
 * `claude` launcher that runs `tests/fixtures/claude-cli/run.ts` with the
 * current Bun binary. The launcher is generated per-test into a temp dir so no
 * platform-specific script has to be committed.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

export const FAKE_CLAUDE_SCRIPT = path.join(
  import.meta.dir,
  "fixtures",
  "claude-cli",
  "run.ts",
)

export function testCredential(
  overrides: Partial<ApiCredential> = {},
): ApiCredential {
  return {
    id: "cred-claude",
    authMode: "bearer",
    value: "test-access-token",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  }
}

export function testConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "conn-claude",
    name: "Claude Test",
    protocol: "claude-native",
    baseUrl: "https://api.anthropic.com",
    enabled: true,
    priority: 1,
    credentials: [testCredential()],
    createdAt: Date.now(),
    ...overrides,
  }
}

/**
 * Write an executable launcher that runs the fake CLI with this Bun binary.
 * Returns its absolute path.
 */
export async function installFakeClaude(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-claude-"))
  const bun = process.execPath
  if (process.platform === "win32") {
    const launcher = path.join(dir, "claude.cmd")
    await fs.writeFile(
      launcher,
      `@echo off\r\n"${bun}" "${FAKE_CLAUDE_SCRIPT}" %*\r\n`,
    )
    return launcher
  }
  const launcher = path.join(dir, "claude")
  await fs.writeFile(
    launcher,
    `#!/bin/sh\nexec "${bun}" "${FAKE_CLAUDE_SCRIPT}" "$@"\n`,
  )
  await fs.chmod(launcher, 0o755)
  return launcher
}

/** Collect an async iterable into an array. */
export async function drain<T>(source: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of source) out.push(item)
  return out
}
