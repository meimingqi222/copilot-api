import { logger } from "~/lib/logger"

/** Windows launchers may own both the CLI and MCP helper processes. */
export function terminateClaudeProcess(proc: Bun.Subprocess): void {
  if (proc.exitCode !== null) return
  const kill = () => {
    try {
      proc.kill()
    } catch {
      /* The process may already have exited. */
    }
  }
  if (process.platform !== "win32") {
    kill()
    return
  }
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
