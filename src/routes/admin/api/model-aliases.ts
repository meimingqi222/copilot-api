import { Hono } from "hono"

import {
  deleteModelAlias,
  listModelAliases,
  replaceModelAliases,
  upsertModelAlias,
  type ModelAliasRule,
} from "~/lib/model-aliases"
import { readJsonBody } from "~/lib/request-body"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"

export const modelAliasApiRoutes = new Hono()

function bodyError(error: unknown) {
  return error instanceof Error ? error.message : "Invalid model alias"
}

modelAliasApiRoutes.get("/", (c) => c.json({ aliases: listModelAliases() }))

modelAliasApiRoutes.post("/", async (c) => {
  try {
    const body = await readJsonBody<Partial<ModelAliasRule>>(c.req.raw)
    return c.json({ alias: upsertModelAlias(body) }, 201)
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})

modelAliasApiRoutes.put("/", async (c) => {
  try {
    const body = await readJsonBody<unknown>(c.req.raw)
    let aliases: Array<Partial<ModelAliasRule>> | undefined
    if (Array.isArray(body)) {
      aliases = body as Array<Partial<ModelAliasRule>>
    } else if (
      body
      && typeof body === "object"
      && Array.isArray((body as { aliases?: unknown }).aliases)
    ) {
      aliases = (body as { aliases: Array<Partial<ModelAliasRule>> }).aliases
    }
    if (!aliases) return c.json({ error: "aliases must be an array" }, 400)
    return c.json({ aliases: replaceModelAliases(aliases) })
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})

modelAliasApiRoutes.put("/:id", async (c) => {
  try {
    const body = await readJsonBody<Partial<ModelAliasRule>>(c.req.raw)
    return c.json({
      alias: upsertModelAlias({ ...body, id: c.req.param("id") }),
    })
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})

modelAliasApiRoutes.delete("/:id", (c) => {
  if (!deleteModelAlias(c.req.param("id"))) {
    return c.json({ error: "Alias not found" }, 404)
  }
  return c.body(null, 204)
})

modelAliasApiRoutes.post("/resolve", async (c) => {
  try {
    const body = await readJsonBody<{ model?: string }>(c.req.raw)
    const model = body.model?.trim()
    if (!model) return c.json({ error: "model is required" }, 400)
    const routing = resolveModelRouting(model)
    const candidates = buildRouteTargets({
      connectionId: routing.connectionId,
      legacyProvider: routing.legacyProvider,
      accountPrefix: routing.accountPrefix,
      publicModelId: routing.modelId,
      aliasRestriction: routing.aliasRestriction,
      onlyAvailable: false,
    })
    return c.json({
      model,
      resolved: routing.modelId,
      aliasChain: routing.aliasChain ?? [routing.modelId],
      matchedRuleIds: routing.matchedAliasRuleIds ?? [],
      candidates: candidates.map((target) => ({
        connectionId: target.connectionId,
        connectionName: target.connectionName,
        upstreamModelId: target.upstreamModelId,
        endpoint: target.endpoint,
      })),
    })
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})
