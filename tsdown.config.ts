import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    main: "src/main.ts",
    "performance-worker": "src/lib/stats/performance-worker.ts",
  },

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  // Native binaries and the ConPTY worker resolve relative to node-pty itself.
  external: ["node-pty"],
  copy: [
    { from: "src/services/claude/cli/tui-tap.js", to: "dist/tui-tap.js" },
    {
      from: "src/services/claude/cli/MAGPIE-LICENSE.txt",
      to: "dist/MAGPIE-LICENSE.txt",
    },
    {
      from: "src/services/aistudio/waa/LICENSE",
      to: "dist/AIStudio2API-LICENSE.txt",
    },
    {
      // account-lifecycle.ts reads this file at runtime via
      // `import.meta.dirname`; the bundled chunk lives at the dist root, and
      // only `dist` is published, so the source tree's copy must ship too.
      from: "src/services/mimo/bridge.py",
      to: "dist/bridge.py",
    },
  ],

  env: {
    NODE_ENV: "production",
  },
})
