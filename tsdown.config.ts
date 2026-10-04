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

  env: {
    NODE_ENV: "production",
  },
})
