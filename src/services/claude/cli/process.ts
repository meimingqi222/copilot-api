import { logger } from "~/lib/logger"

/**
 * How long Claude Code may take to exit on its own before it is killed.
 * A Claude Code killed outright cannot run its exit cleanup, and one holding
 * the OAuth refresh lock leaves it behind for every later run to fail on
 * ("another Claude Code process is refreshing it").
 */
export const CLAUDE_EXIT_GRACE_MS = 5_000

/**
 * Asks the CLI to exit, then kills it if it has not within `graceMs`.
 *
 * POSIX: SIGTERM, then SIGKILL. Windows has no SIGTERM (Bun's kill is
 * TerminateProcess), so the ask is closing stdin: with stream-json input
 * Claude Code exits on EOF. The kill is `taskkill /T /F`, because Windows
 * launchers may own both the CLI and MCP helper processes.
 */
export function terminateClaudeProcess(
  proc: Bun.Subprocess,
  { graceMs = CLAUDE_EXIT_GRACE_MS }: { graceMs?: number } = {},
): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === "win32") closeStdin(proc)
  else signal(proc, "SIGTERM")
  const force = () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    if (process.platform === "win32") killTree(proc)
    else signal(proc, "SIGKILL")
  }
  if (graceMs <= 0) return force()
  const timer = setTimeout(force, graceMs)
  timer.unref?.()
  void proc.exited.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  )
}

function closeStdin(proc: Bun.Subprocess): void {
  const stdin = proc.stdin
  if (!stdin || typeof stdin === "number") return
  try {
    void stdin.end()
  } catch {
    /* Already closed. */
  }
}

function signal(proc: Bun.Subprocess, name: "SIGTERM" | "SIGKILL"): void {
  try {
    proc.kill(name)
  } catch {
    /* The process may already have exited. */
  }
}

function killTree(proc: Bun.Subprocess): void {
  const kill = () => signal(proc, "SIGKILL")
  try {
    const task = Bun.spawn(
      ["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
    void task.exited.then(
      (code) => {
        if (code !== 0 && proc.exitCode === null)
          logger.warn("claude-cli: process tree termination failed", { code })
        kill()
      },
      (error: unknown) => {
        logger.warn("claude-cli: process tree termination failed", {
          error: String(error),
        })
        kill()
      },
    )
  } catch (error) {
    logger.warn("claude-cli: process tree termination unavailable", {
      error: String(error),
    })
    kill()
  }
}
