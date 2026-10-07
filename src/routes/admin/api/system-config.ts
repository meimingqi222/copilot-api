import { Hono } from "hono"

import { readJsonBody } from "~/lib/request-body"
import { state } from "~/lib/state"
import { publicRoutingGroupModels } from "~/lib/routing-groups/catalog"
import { refreshModelsForAllAccounts } from "~/lib/utils"
import { buildCodexClientModelsResponse } from "~/services/codex/client-models"
import {
  getSystemConfig,
  systemConfigUpdateSchema,
  updateSystemConfig,
} from "~/lib/system-config"

export const systemConfigApiRoutes = new Hono()

systemConfigApiRoutes.get("/", (c) => c.json(getSystemConfig()))

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
