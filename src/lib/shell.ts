import { execSync } from "node:child_process"
import process from "node:process"

type ShellName = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "sh"
type EnvVars = Record<string, string | undefined>

function getShell(): ShellName {
  const { platform, ppid, env } = process

  if (platform === "win32") {
    try {
      const command = `wmic process get ParentProcessId,Name | findstr "${ppid}"`
      const parentProcess = execSync(command, { stdio: "pipe" }).toString()

      if (parentProcess.toLowerCase().includes("powershell.exe")) {
        return "powershell"
      }
    } catch {
      return "cmd"
    }

    return "cmd"
  } else {
    const shellPath = env.SHELL
    if (shellPath) {
      if (shellPath.endsWith("zsh")) return "zsh"
      if (shellPath.endsWith("fish")) return "fish"
      if (shellPath.endsWith("bash")) return "bash"
    }

    return "sh"
  }
}

// Escape single quotes in POSIX shells: end the single-quote string, insert an
// escaped single quote, then reopen the string.
function escapePosixSingleQuote(value: string): string {
  return value.replaceAll("'", String.raw`'\''`)
}

// PowerShell single-quoted strings treat ' as literal except '' which is an
// escaped single quote.
function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''")
}

// CMD does not support reliable escaping for all characters, but we prevent the
// most dangerous injection by stripping control characters and escaping % (env
// var expansion) and & | < > ^ (command separators/redirectors).
function escapeCmd(value: string): string {
  return value
    .replaceAll("%", "%%")
    .replaceAll("^", "^^")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>")
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = "",
): string {
  const shell = getShell()
  const filteredEnvVars = Object.entries(envVars).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>

  let commandBlock: string

  switch (shell) {
    case "powershell": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = '${escapePowerShell(value)}'`)
        .join("; ")
      break
    }
    case "cmd": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set ${key}=${escapeCmd(value)}`)
        .join(" & ")
      break
    }
    case "fish": {
      commandBlock = filteredEnvVars
        .map(
          ([key, value]) => `set -gx ${key} '${escapePosixSingleQuote(value)}'`,
        )
        .join("; ")
      break
    }
    default: {
      // bash, zsh, sh
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}='${escapePosixSingleQuote(value)}'`)
        .join(" ")
      commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ""
      break
    }
  }

  if (commandBlock && commandToRun) {
    const separator = shell === "cmd" ? " & " : " && "
    return `${commandBlock}${separator}${commandToRun}`
  }

  return commandBlock || commandToRun
}
