#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

const argv = process.argv.slice(2)

// `claude-mcp-helper` is spawned by the real `claude` binary, not by a human.
// It speaks newline-delimited JSON-RPC on stdio, so it must be dispatched
// before anything else can write to stdout — including citty's help output and
// the app's own startup banner. Keep this branch free of heavy imports.
if (argv[0] === "claude-mcp-helper") {
  const { runClaudeMcpHelper } = await import(
    "./services/claude/cli/mcp-helper"
  )
  process.exitCode = await runClaudeMcpHelper(argv.slice(1))
} else {
  const [{ auth }, { debug }, { key }, { start }] = await Promise.all([
    import("./auth"),
    import("./debug"),
    import("./key"),
    import("./start"),
  ])

  const main = defineCommand({
    meta: {
      name: "copilot-api",
      description:
        "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
    },
    subCommands: { auth, start, debug, key },
  })

  await runMain(main)
}
