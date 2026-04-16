import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels, refreshModelsForAllAccounts } from "~/lib/utils"
import { getPublicModelData } from "~/services/copilot/responses-api"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      await refreshModelsForAllAccounts()
      cacheModels()
    }

    const models = state.models?.data.map((model) => getPublicModelData(model))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})
