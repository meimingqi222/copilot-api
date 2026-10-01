import { Hono } from "hono"

import { readJsonBody } from "~/lib/request-body"
import {
  DAY_NAMES,
  deleteRoutingGroup,
  EFFORT_LEVELS,
  getRoutingGroup,
  groupReferenceFor,
  listHiddenAutoGroups,
  listMemberOptions,
  listRoutingGroups,
  replaceRoutingGroups,
  restoreAutoGroup,
  RoutingGroupValidationError,
  upsertRoutingGroup,
  type RoutingGroup,
} from "~/lib/routing-groups"
import { groupModelReference } from "~/lib/routing-groups/resolve"

export const routingGroupsApiRoutes = new Hono()

/**
 * What the UI shows next to a member field. Members are written the way the
 * request path reads them, so the help text names the suffixes rather than
 * restating the parser.
 */
const MEMBER_EFFORT_HELP =
  "A member is provider/model with optional :effort and :fast suffixes, e.g. vendor/model:high:fast."

function bodyError(error: unknown) {
  if (error instanceof RoutingGroupValidationError) return error.message
  return error instanceof Error ? error.message : "Invalid routing group"
}

routingGroupsApiRoutes.get("/", async (c) =>
  c.json({ groups: await listRoutingGroups() }),
)

// The vocabulary the editor needs: the levels a rule may ask for, how a member
// spells them, and the day names a time window accepts.
routingGroupsApiRoutes.get("/meta", (c) =>
  c.json({
    effortLevels: [...EFFORT_LEVELS],
    memberEffortHelp: MEMBER_EFFORT_HELP,
    days: [...DAY_NAMES],
  }),
)

routingGroupsApiRoutes.get("/references", async (c) => {
  const groups = await listRoutingGroups()
  return c.json({
    references: groups.map((group) => ({
      id: group.id,
      name: group.name,
      reference: groupModelReference(group.id),
    })),
  })
})

// The group a bare model name resolves to, so the editor (and any client) can
// ask "which group does `claude-opus-5.5` belong to?" without a group id in hand.
routingGroupsApiRoutes.get("/lookup", async (c) => {
  const model = c.req.query("model") ?? ""
  const reference = groupReferenceFor(model, await listRoutingGroups())
  if (!reference) return c.json({ error: "No group for that model" }, 404)
  return c.json({ model, reference })
})

// The derived groups the user removed, so the editor can offer to restore them.
routingGroupsApiRoutes.get("/hidden", async (c) =>
  c.json({ hidden: await listHiddenAutoGroups() }),
)

// The models a member may name, so the editor can offer a picker instead of a
// free-text `provider/model` box.
routingGroupsApiRoutes.get("/models", (c) =>
  c.json({ models: listMemberOptions() }),
)

routingGroupsApiRoutes.get("/:id", async (c) => {
  const group = await getRoutingGroup(c.req.param("id"))
  if (!group) return c.json({ error: "Group not found" }, 404)
  return c.json({ group })
})

routingGroupsApiRoutes.post("/", async (c) => {
  try {
    const body = await readJsonBody<RoutingGroup>(c.req.raw)
    return c.json({ group: await upsertRoutingGroup(body) }, 201)
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})

routingGroupsApiRoutes.put("/", async (c) => {
  try {
    const body = await readJsonBody<unknown>(c.req.raw)
    let groups: Array<RoutingGroup> | undefined
    if (Array.isArray(body)) {
      groups = body as Array<RoutingGroup>
    } else if (
      body
      && typeof body === "object"
      && Array.isArray((body as { groups?: unknown }).groups)
    ) {
      groups = (body as { groups: Array<RoutingGroup> }).groups
    }
    if (!groups) return c.json({ error: "groups must be an array" }, 400)
    return c.json({ groups: await replaceRoutingGroups(groups) })
  } catch (error) {
    return c.json({ error: bodyError(error) }, 400)
  }
})

routingGroupsApiRoutes.delete("/:id", async (c) => {
  if (!(await deleteRoutingGroup(c.req.param("id")))) {
    return c.json({ error: "Group not found" }, 404)
  }
  return c.json({ ok: true })
})

// Bring back a derived group the user removed (a hidden one). A stored group is
// not restorable this way — it was deleted, not hidden.
routingGroupsApiRoutes.post("/:id/restore", async (c) => {
  if (!(await restoreAutoGroup(c.req.param("id")))) {
    return c.json({ error: "No hidden group with that id" }, 404)
  }
  return c.json({ ok: true })
})
