import { logger } from "~/lib/logger"

import { HTTPError } from "./error"

export const awaitApproval = async () => {
  const response = await logger.prompt(`Accept incoming request?`, {
    type: "confirm",
  })

  if (!response)
    throw new HTTPError(
      "Request rejected",
      Response.json({ message: "Request rejected" }, { status: 403 }),
    )
}
