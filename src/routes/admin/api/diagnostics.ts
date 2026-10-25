import { Hono } from "hono"
import { z } from "zod"

import {
  BUNDLE_SECTIONS,
  buildDiagnosticBundle,
  bundleFileName,
  compressBundle,
} from "~/lib/diagnostics/bundle"
import { readJsonBody } from "~/lib/request-body"
import { systemStatus } from "~/lib/system-status"

export const diagnosticsApiRoutes = new Hono()

diagnosticsApiRoutes.get("/status", async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(await systemStatus())
})

const bundleSchema = z
  .object({
    sinceHours: z
      .number()
      .positive()
      .max(24 * 30)
      .default(24),
    sections: z.array(z.enum(BUNDLE_SECTIONS)).min(1).optional(),
    requests: z.enum(["failed", "all"]).default("failed"),
    systemLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Only the manifest: what the download would hold, before downloading. */
    preview: z.boolean().default(false),
  })
  .strict()

diagnosticsApiRoutes.post("/bundle", async (c) => {
  c.header("Cache-Control", "no-store")
  let input: unknown
  try {
    input = await readJsonBody(c.req.raw, 16 * 1024)
  } catch {
    return c.json({ error: "Invalid bundle options." }, 400)
  }
  const parsed = bundleSchema.safeParse(input ?? {})
  if (!parsed.success) return c.json({ error: "Invalid bundle options." }, 400)
  const options = parsed.data
  const bundle = await buildDiagnosticBundle({
    sinceMs: options.sinceHours * 3_600_000,
    sections: options.sections,
    requests: options.requests,
    systemLevel: options.systemLevel,
  })
  if (options.preview) {
    const compressed = compressBundle(bundle)
    return c.json({ manifest: bundle.manifest, bytes: compressed.byteLength })
  }
  return c.body(compressBundle(bundle), 200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${bundleFileName()}"`,
  })
})
