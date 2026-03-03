import { Hono } from "hono"

import { getActiveAccount } from "~/lib/accounts"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    const account = getActiveAccount()
    return c.json({
      token: account.copilotToken,
    })
  } catch (error) {
    console.error("Error fetching token:", error)
    return c.json({ error: "Failed to fetch token", token: null }, 500)
  }
})
