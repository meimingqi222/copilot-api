import { Hono } from "hono"

import { initializeProviderRegistry } from "~/services/providers"
import { listProviderDescriptors } from "~/services/providers/registry"

export const providerApiRoutes = new Hono()

providerApiRoutes.get("/", (c) => {
  initializeProviderRegistry()
  return c.json({
    providers: listProviderDescriptors(),
  })
})
