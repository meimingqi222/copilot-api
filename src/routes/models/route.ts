import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { recordTraceError } from "~/lib/request-log"
import { state } from "~/lib/state"
import { isUserAllowedModel, type User } from "~/lib/users"
import { refreshModelsForAllAccounts } from "~/lib/utils"
import { getPublicModelData } from "~/services/copilot/responses-api"
import {
  buildGrokShellModelsResponse,
  isGrokShellUserAgent,
} from "~/services/xai/grok-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      await refreshModelsForAllAccounts()
    }

    const user = c.get("user" as never) as User | undefined
    const filtered =
      state.models?.data.filter(
        (model) => !user || isUserAllowedModel(user, model.id),
      ) ?? []

    // Grok Shell / Grok Build clients expect a dedicated model catalog shape
    // (api_backend, supported_in_api, reasoning_efforts). Mirrors CPA
    // handleGrokModels / grokbuild.BuildResponse.
    if (isGrokShellUserAgent(c.req.header("User-Agent"))) {
      return c.json(buildGrokShellModelsResponse(filtered))
    }

    const models = filtered.map((model) => getPublicModelData(model))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
