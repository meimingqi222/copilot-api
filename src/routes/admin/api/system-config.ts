import { Hono } from "hono"
import { z } from "zod"

import { HTTPError } from "~/lib/error"
import { readJsonBody } from "~/lib/request-body"
import { RedactionScope } from "~/lib/redaction/context"
import {
  clearRedactionInspection,
  emptyRedactionDiagnostics,
  getRedactionDiagnostics,
  getRedactionInspection,
  getRedactionInspectionState,
  setRedactionInspection,
  subscribeRedactionDiagnostics,
} from "~/lib/redaction/diagnostics"
import { summarizeRedactionHistory } from "~/lib/redaction/history"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { state } from "~/lib/state"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { getAccountWarmupModels } from "~/lib/quota/warmup"
import { publicRoutingGroupModels } from "~/lib/routing-groups/catalog"
import { refreshModelsForAllAccounts } from "~/lib/utils"
import { buildCodexClientModelsResponse } from "~/services/codex/client-models"
import {
  getSystemConfig,
  systemConfigUpdateSchema,
  updateRedactionConfig,
  updateSystemConfig,
} from "~/lib/system-config"

export const systemConfigApiRoutes = new Hono()

systemConfigApiRoutes.get("/", (c) => c.json(getSystemConfig()))

systemConfigApiRoutes.put("/redaction-config", async (c) => {
  let input: unknown
  try {
    input = await readJsonBody(c.req.raw, 1024 * 1024)
  } catch (error) {
    return c.json(
      { error: "Invalid or oversized redaction payload." },
      error instanceof HTTPError && error.response.status === 413 ? 413 : 400,
    )
  }
  const parsed = redactionConfigSchema.safeParse(input)
  if (!parsed.success)
    return c.json({ error: "Invalid redaction configuration or rules." }, 400)
  return c.json(updateRedactionConfig(parsed.data))
})

systemConfigApiRoutes.get("/redaction-stats", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(getRedactionDiagnostics())
})

// Invalidation only: request bodies and originals never enter this feed.
systemConfigApiRoutes.get("/redaction-events", (c) => {
  return handleSseStream(c, async (stream, signal) => {
    await new Promise<void>((resolve) => {
      let pending = false
      let dirty = false
      let closed = false
      const stop = () => {
        closed = true
        unsubscribe()
        signal.removeEventListener("abort", stop)
        resolve()
      }
      const flush = async () => {
        dirty = true
        if (pending || closed) return
        pending = true
        try {
          while (dirty && !closed) {
            dirty = false
            await writeSseEvent(stream, "{}", "change")
          }
        } catch {
          stop()
        } finally {
          pending = false
        }
      }
      const unsubscribe = subscribeRedactionDiagnostics(() => {
        void flush()
      })
      if (signal.aborted) stop()
      else {
        signal.addEventListener("abort", stop, { once: true })
        void flush()
      }
    })
  })
})

systemConfigApiRoutes.get("/redaction-history", async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(await summarizeRedactionHistory(Number(c.req.query("days"))))
})

systemConfigApiRoutes.post("/redaction-inspection", async (c) => {
  c.header("Cache-Control", "no-store")
  let input: unknown
  try {
    input = await readJsonBody(c.req.raw, 1024)
  } catch {
    return c.json({ error: "Invalid inspection settings." }, 400)
  }
  const parsed = z
    .object({
      enabled: z.boolean(),
      mode: z.enum(["continuous", "temporary"]).optional(),
    })
    .strict()
    .safeParse(input)
  if (!parsed.success)
    return c.json({ error: "Invalid inspection settings." }, 400)
  return c.json(setRedactionInspection(parsed.data.enabled, parsed.data.mode))
})

systemConfigApiRoutes.delete("/redaction-records", (c) => {
  c.header("Cache-Control", "no-store")
  clearRedactionInspection()
  return c.json(getRedactionInspectionState())
})

systemConfigApiRoutes.get("/redaction-records/:id", (c) => {
  c.header("Cache-Control", "no-store")
  const id = Number(c.req.param("id"))
  const detail =
    Number.isSafeInteger(id) && id > 0 ?
      getRedactionInspection(id, c.req.query("reveal") === "1")
    : undefined
  return detail ?
      c.json(detail)
    : c.json({ error: "Record unavailable or expired." }, 404)
})

const redactionPreviewSchema = z
  .object({
    text: z.string().max(65536),
    format: z.enum(["text", "json"]),
    config: redactionConfigSchema,
  })
  .strict()

systemConfigApiRoutes.post("/redaction-preview", async (c) => {
  c.header("Cache-Control", "no-store")
  let input: unknown
  try {
    input = await readJsonBody(c.req.raw, 1024 * 1024)
  } catch (error) {
    return c.json(
      { error: "Invalid or oversized preview payload." },
      error instanceof HTTPError && error.response.status === 413 ? 413 : 400,
    )
  }
  const parsed = redactionPreviewSchema.safeParse(input)
  if (!parsed.success)
    return c.json(
      {
        error: "Invalid preview input or rules (text limit: 65536 characters).",
      },
      400,
    )
  const { text, format, config } = parsed.data
  try {
    const value: unknown = format === "json" ? JSON.parse(text) : text
    if (!config.enabled)
      return c.json({
        output: text,
        enabled: false,
        diagnostics: emptyRedactionDiagnostics(),
      })
    // No caller identity, lease, upstream call or telemetry recording. The
    // preview's mappings die with this isolated scope, even for known secrets.
    const scope = new RedactionScope(config, undefined, { preview: true })
    const masked = scope.mask(value)
    return c.json({
      output: format === "json" ? JSON.stringify(masked, null, 2) : masked,
      enabled: true,
      diagnostics: scope.diagnostics(),
    })
  } catch {
    // JSON parser errors can contain excerpts of the user's sensitive input.
    return c.json(
      {
        error:
          "Preview failed. Check JSON syntax, nesting and redaction limits.",
      },
      400,
    )
  }
})

systemConfigApiRoutes.get("/warmup-models", (c) =>
  c.json({ models: getAccountWarmupModels() }),
)

systemConfigApiRoutes.get("/codex-models", async (c) => {
  if (!state.models) await refreshModelsForAllAccounts()
  const catalog = new Map(
    [...(state.models?.data ?? []), ...(await publicRoutingGroupModels())].map(
      (model) => [model.id, model],
    ),
  )
  const { models } = buildCodexClientModelsResponse(
    [...catalog.values()],
    "",
    null,
  )
  return c.json({
    models: models
      .filter((model) => model.visibility === "list")
      .map((model) => ({ id: model.slug, name: model.display_name })),
  })
})

systemConfigApiRoutes.put("/", async (c) => {
  let input: unknown
  try {
    input = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const parsed = systemConfigUpdateSchema.safeParse(input)
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      400,
    )
  }
  return c.json(updateSystemConfig(parsed.data))
})
