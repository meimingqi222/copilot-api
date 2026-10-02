import { Hono } from "hono"

import { readJsonBody } from "~/lib/request-body"
import {
  getSystemConfig,
  systemConfigUpdateSchema,
  updateSystemConfig,
} from "~/lib/system-config"

export const systemConfigApiRoutes = new Hono()

systemConfigApiRoutes.get("/", (c) => c.json(getSystemConfig()))

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
